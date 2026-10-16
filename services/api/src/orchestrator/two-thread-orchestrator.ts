/**
 * Layer 3: Two-Thread Orchestrator (DisFAP Spec Layer 3).
 *
 * "Whenever, any interested client pays for using any of the advertised software
 * for a certain amount of time, the third layer consisting of the orchestrator
 * is triggered. It spawns two threads, one for spooling up a virtual machine and
 * another for retrieving credentials ensuring utmost efficiency."
 *
 * How the two threads map onto this implementation:
 *  - THREAD 2 — credential retrieval: ATOMICALLY claim the license (a
 *    conditional compare-and-set, so two concurrent rents can never both win),
 *    then redeem the HSM RSA-4096 payload and decrypt inside the HSM boundary. Sub-millisecond.
 *  - THREAD 1 — VM spooling: `createSession` with the DECRYPTED license
 *    credential. The control plane writes it onto the VM's disk *before*
 *    RunInstances (spec "Working Explanation" step 5 — pre-boot injection) and
 *    stages it in Vault for the guacd handshake at connect time.
 *
 * Concurrency note (honest accounting): thread 1 waits on thread 2 only for
 * the sealed credential (milliseconds) because the spec's pre-boot ordering
 * requires it; the expensive VM spool still dominates. Telemetry below keeps
 * thread timings separately so the spec's "utmost efficiency" claim stays
 * measurable.
 *
 * The plaintext license credential exists in this process ONLY for the span
 * between `hsm.decrypt` and the pair-seal / createSession hand-off — it is
 * never logged, never persisted unsealed, and never returned to any client.
 */

import type { HsmService } from '../crypto/hsm-rsa.js';
import type { PairKeyService, PairEncryptedPayload } from '../crypto/pair-keys.js';
import type { MarketplaceStore } from '../marketplace/license-store.js';
import type { MeterEventInput } from '../billing/stripe-client.js';
import type { Principal } from '../auth/authenticator.js';
import type { CreateSessionInput, CreateSessionResult } from '../sessions/create-session.js';
import type { EventRecorder } from '../ports.js';
import { isTerminal, type SessionState } from '../state-machine.js';

export interface ThreadExecutionTelemetry {
  thread1VmSpoolingMs: number;
  thread2CredentialRetrievalMs: number;
  orchestratorTotalMs: number;
  hsmKeyFingerprint: string;
}

export interface RentLicenseInput {
  licenseId: string;
  hoursRequested: number;
  clientIp?: string;
  clientUa?: string;
}

export interface RentLicenseResult extends CreateSessionResult {
  rentalId: string;
  license: {
    id: string;
    softwareName: string;
    version: string;
    hourlyRateUsd: number;
    totalChargedUsd: number;
  };
  telemetry: ThreadExecutionTelemetry;
}

/** The Stripe seam the orchestrator meters paid rentals onto. */
export interface RentalMeter {
  reportMeterEvent(input: MeterEventInput): Promise<{ id: string }>;
}

export interface TwoThreadOrchestratorDeps {
  hsm: HsmService;
  marketplace: MarketplaceStore;
  createSession: (principal: Principal, input: CreateSessionInput) => Promise<CreateSessionResult>;
  /**
   * Tears down a session (and its VM) after a failure that happens once the
   * session already exists — e.g. the rental row could not be persisted. The
   * compensation releases the license claim only when this reports a TERMINAL
   * state. Absent ⇒ the claim is held (fail-safe): we will not free a license
   * whose session we cannot prove is gone.
   */
  terminateSession?: (sessionId: string) => Promise<{ state: string }>;
  /** Records the compensating teardown for observability. */
  events?: EventRecorder;
  /** Reports the rental as metered usage; optional in un-metered dev. */
  meter?: RentalMeter;
  /** Per owner-rentee credential re-seal (spec TA-4); optional in Phase-0. */
  pairKeys?: PairKeyService;
  /**
   * DEV ONLY: allow re-renting a license that is not currently `available`.
   * Off by default. Replaces the previous NODE_ENV-based bypass so a mis-set
   * environment can never silently double-rent a license (audit finding H3).
   */
  devAllowRerent?: boolean;
}

export class TwoThreadOrchestrator {
  constructor(private readonly deps: TwoThreadOrchestratorDeps) {}

  /**
   * Spawns Thread 1 (VM Spooling) and Thread 2 (Credential Retrieval/HSM Decryption)
   * and unifies them into a ready session.
   */
  async rentAndOrchestrate(principal: Principal, input: RentLicenseInput): Promise<RentLicenseResult> {
    const startTime = Date.now();

    // 1. Cheap pre-check for a friendly 404/409. Advisory only: the
    //    AUTHORITATIVE guard is the atomic claim in Thread 2 (audit finding H2).
    const license = await this.deps.marketplace.findById(input.licenseId);
    if (!license) {
      const err = new Error(`Software license ${input.licenseId} not found`);
      (err as unknown as { statusCode: number }).statusCode = 404;
      throw err;
    }
    if (license.status !== 'available') {
      // Re-rental is an explicit, OPT-IN dev affordance. It is OFF by default
      // so a busy license is rejected with 409 in every environment; the old
      // `NODE_ENV !== 'production'` check failed open in staging/test (H3).
      if (this.deps.devAllowRerent) {
        // Forced release of another holder's claim — dev-only, flag-gated.
        await this.deps.marketplace.markAvailable(license.id);
      } else {
        const err = new Error(`Software license ${license.softwareName} is currently ${license.status}`);
        (err as unknown as { statusCode: number }).statusCode = 409;
        throw err;
      }
    }

    // ── THREAD 2: Retrieving & decrypting credentials via HSM ────────────────
    // Runs concurrently with the VM thread below; the VM thread joins it only
    // to pick up the credential it needs BEFORE RunInstances (pre-boot
    // injection ordering, spec Working Explanation step 5).
    const thread2Promise = (async () => {
      const t2Start = Date.now();

      // ATOMIC CLAIM: conditional compare-and-set. Exactly one concurrent rent
      // of this license wins; every other caller gets false → 409. Never a
      // read-then-write (finding H2).
      const won = await this.deps.marketplace.claimAvailable(license.id, principal.userId);
      if (!won) {
        const err = new Error(`Software license ${license.softwareName} was just taken`);
        (err as unknown as { statusCode: number }).statusCode = 409;
        throw err;
      }

      try {
        // Decrypt within the HSM boundary (we now hold the claim).
        const decryptedPlaintext = this.deps.hsm.decrypt(license.encryptedCredentials);
        const credentials = JSON.parse(decryptedPlaintext) as {
          username: string;
          password?: string;
          privateKey?: string;
        };
        return { credentials, decryptedPlaintext, t2Duration: Date.now() - t2Start };
      } catch (err) {
        // We hold a claim we cannot use — give it back before surfacing, or the
        // license would stay stuck `rented` with no session behind it.
        await this.deps.marketplace.releaseClaim(license.id, principal.userId).catch(() => undefined);
        throw err;
      }
    })();

    // ── THREAD 1: Spooling up a virtual machine ──────────────────────────────
    const thread1Promise = (async () => {
      const t1Start = Date.now();
      const { credentials } = await thread2Promise;
      const sessionResult = await this.deps.createSession(principal, {
        templateId: license.templateId,
        // Durable license link: persisted on the session row at creation so the
        // rental reaper can always prove a claimed license still has a live
        // session before it may release the claim.
        licenseId: license.id,
        ...(input.clientIp ? { clientIp: input.clientIp } : {}),
        ...(input.clientUa ? { clientUa: input.clientUa } : {}),
        // Server-side authorization for the (possibly other-org) licensed
        // template. Minted here, never derived from client input (finding C2).
        templateGrant: { licenseId: license.id },
        // The license credential IS the session credential: pre-boot injection
        // writes it to the VM disk, the Vault issuer stages it for guacd.
        credential: {
          username: credentials.username,
          ...(credentials.password !== undefined ? { password: credentials.password } : {}),
          ...(credentials.privateKey !== undefined ? { privateKey: credentials.privateKey } : {}),
        },
      });
      const t1Duration = Date.now() - t1Start;
      return { sessionResult, t1Duration };
    })();

    // Concurrently await both threads (utmost efficiency as per Layer 3 spec).
    // On ANY failure before a valid session exists we COMPENSATE: release the
    // claim conditionally (never touching another tenant's claim) and surface
    // the error. No rental row and no meter event are ever created for a
    // session that never became valid.
    const [thread1Result, thread2Result] = await Promise.all([thread1Promise, thread2Promise]).catch(
      async (err: unknown) => {
        await this.deps.marketplace.releaseClaim(license.id, principal.userId).catch(() => undefined);
        throw err;
      },
    );

    // ── Re-seal under the unique per owner-rentee pair key (spec TA-4) ────────
    let pairPayload: PairEncryptedPayload | undefined;
    if (this.deps.pairKeys) {
      pairPayload = this.deps.pairKeys.encrypt(license.ownerId, principal.userId, thread2Result.decryptedPlaintext);
    }

    const sessionId = thread1Result.sessionResult.sessionId;
    const hoursRequested = Math.max(1, input.hoursRequested);
    const totalChargedUsd = Number((license.hourlyRateUsd * hoursRequested).toFixed(2));

    // The session is valid from here on. ORDER MATTERS: persist the rental
    // FIRST, then meter, then attach the meter id — so we never meter a session
    // that has no rental, and a meter failure leaves a recoverable
    // `meter_event_id = null` rather than a phantom charge.
    //
    // If persisting the rental itself fails, we COMPENSATE: tear the freshly
    // created session (and its VM) down and release the claim ONLY once the
    // session is confirmed terminal. While it cannot be confirmed, the claim
    // stays held — the durable `sessions.license_id` link proves to the rental
    // reaper that the session may still be live, so it will not release the
    // license out from under an active session.
    const rental = await this.deps.marketplace
      .recordRental({
        licenseId: license.id,
        renteeId: principal.userId,
        sessionId,
        hoursRequested,
        totalChargedUsd,
        ...(pairPayload !== undefined ? { pairPayload } : {}),
      })
      .catch(async (err: unknown) => {
        await this.compensateUnpersistedRental(license.id, principal.userId, sessionId);
        throw err;
      });

    if (this.deps.meter) {
      const identifier = `lic_${license.id}_ses_${sessionId}`;
      try {
        const metered = await this.deps.meter.reportMeterEvent({
          eventName: 'dfap_license_rental_hours',
          stripeCustomerId: `org_${principal.orgId}`,
          value: totalChargedUsd,
          identifier,
        });
        await this.deps.marketplace.attachMeterEvent(rental.id, metered.id).catch(() => undefined);
      } catch {
        // Recoverable obligation: rental.meterEventId stays null for a later
        // reconciliation pass; the live session is unaffected.
      }
    }

    const totalMs = Date.now() - startTime;

    return {
      ...thread1Result.sessionResult,
      rentalId: rental.id,
      license: {
        id: license.id,
        softwareName: license.softwareName,
        version: license.version,
        hourlyRateUsd: license.hourlyRateUsd,
        totalChargedUsd,
      },
      telemetry: {
        thread1VmSpoolingMs: thread1Result.t1Duration,
        thread2CredentialRetrievalMs: thread2Result.t2Duration,
        orchestratorTotalMs: totalMs,
        hsmKeyFingerprint: this.deps.hsm.getKeyFingerprint(),
      },
    };
  }

  /**
   * Compensates a failure that happens AFTER a valid session exists but BEFORE
   * its rental was persisted. We attempt to terminate the session (and its VM);
   * the license claim is released ONLY when the session is confirmed terminal.
   *
   * If teardown cannot be confirmed, the claim is deliberately LEFT in place.
   * The durable `sessions.license_id` link then makes the license ineligible for
   * stale-claim release until the session is confirmed terminal or absent (see
   * `marketplace/rental-reaper.ts`). Idempotent and safe under retries: the
   * release is conditional on our own rentee, so a concurrent re-rent is never
   * clobbered.
   */
  private async compensateUnpersistedRental(licenseId: string, renteeId: string, sessionId: string): Promise<void> {
    let terminated = false;
    if (this.deps.terminateSession) {
      try {
        const res = await this.deps.terminateSession(sessionId);
        terminated = isTerminal(res.state as SessionState);
      } catch {
        terminated = false;
      }
    }

    if (terminated) {
      await this.deps.marketplace.releaseClaim(licenseId, renteeId).catch(() => undefined);
    }

    await this.deps.events
      ?.record(sessionId, 'rental_persist_failed', renteeId, { licenseId, terminated })
      .catch(() => undefined);
  }
}
