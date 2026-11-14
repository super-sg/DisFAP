/**
 * Rental reaper — the recovery loop for the software-license rental ledger
 * (DisFAP spec layer 1/3, audit findings H1/M6).
 *
 * Two situations leave a rental/claim inconsistent; both use information that
 * already exists in the schema, so NO migration is required:
 *
 *  1. EXPIRED LEASE — a rental (`license_rentals`) whose paid-for window
 *     (`started_at + hours_requested`) has passed but is still open
 *     (`ended_at IS NULL`). We close it and release the license ONLY when the
 *     pixel session it drove is terminal (`ended`/`failed`) or gone. If the
 *     session is still live we DO NOTHING: a stale timestamp must never steal
 *     the license out from under a valid, running session.
 *
 *  2. ABANDONED CLAIM — a license left `rented` with no open rental at all,
 *     e.g. a crash between the atomic claim and rental persistence. It is
 *     released only once it has been untouched past the grace window AND no
 *     non-terminal session is durably linked to it (`sessions.license_id`).
 *     Missing rental is NOT proof that no session exists: if a linked session
 *     may still be live the claim is HELD, never stolen from a running session.
 *
 *  3. STALE PAIR PAYLOAD — a rental-scoped credential re-seal left on an
 *     ALREADY-ENDED rental (`license_rentals.pair_payload`). A cleanup
 *     obligation, not a correctness one: the payload is meaningless once the
 *     rental is over, so the sweep drops it. Idempotent.
 *
 * The planning step is pure (`planRentalReap`) so every branch is unit-testable
 * without a store; `reconcile()` fetches inputs and applies the plan with
 * per-item error isolation. Both actions are idempotent: a second pass sees
 * nothing left to do.
 */

import { isTerminal, type SessionState } from '../state-machine.js';
import type { RentalLease } from './license-store.js';

/** Grace beyond the lease window before an open rental is eligible. */
export const RENTAL_GRACE_MS = 15 * 60 * 1000;
/** Grace before a rented-but-rental-less license is treated as abandoned. */
export const ABANDONED_CLAIM_GRACE_MS = 15 * 60 * 1000;

export interface RentalReapPlan {
  /** Expired rentals whose session is terminal/gone — safe to close. */
  closeRentals: RentalLease[];
  /** Expired rentals whose session is still live — deliberately left alone. */
  skippedActive: RentalLease[];
  /** License ids whose claim is abandoned and may be released. */
  releaseClaims: string[];
  /** Abandoned claims HELD because a linked session may still be live. */
  heldClaims: string[];
}

/**
 * Pure planning. `sessionStates` maps a session id to its state, or `null`
 * when no such session row exists. `activeLicenses` is the set of license ids
 * that still have a non-terminal linked session — their claims are held.
 */
export function planRentalReap(
  expired: readonly RentalLease[],
  sessionStates: ReadonlyMap<string, string | null>,
  staleClaims: readonly string[],
  activeLicenses: ReadonlySet<string> = new Set<string>(),
): RentalReapPlan {
  const closeRentals: RentalLease[] = [];
  const skippedActive: RentalLease[] = [];

  for (const lease of expired) {
    const state = sessionStates.get(lease.sessionId) ?? null;
    // Missing session ⇒ nothing is running under it ⇒ safe to close.
    // Terminal session ⇒ already finished ⇒ safe to close.
    // Anything else ⇒ treat as live and leave it entirely alone.
    if (state === null || isTerminal(state as SessionState)) closeRentals.push(lease);
    else skippedActive.push(lease);
  }

  // A stale claim is released only when we can prove no session for it may be
  // live. `activeLicenses` is computed with fail-safe semantics by the caller.
  const releaseClaims: string[] = [];
  const heldClaims: string[] = [];
  for (const licenseId of staleClaims) {
    if (activeLicenses.has(licenseId)) heldClaims.push(licenseId);
    else releaseClaims.push(licenseId);
  }

  return { closeRentals, skippedActive, releaseClaims, heldClaims };
}

/** The subset of `MarketplaceStore` the reaper needs. */
export interface RentalReaperStore {
  listExpiredOpenRentals(now: Date): Promise<RentalLease[]>;
  closeRental(rentalId: string, at: Date): Promise<void>;
  listStaleClaims(olderThan: Date): Promise<string[]>;
  markAvailable(licenseId: string): Promise<void>;
  /**
   * Optional durable cleanup obligation: drop rental-scoped pair payloads on
   * already-ended rentals. Idempotent; skipped when the store does not
   * implement it (e.g. a narrow test double).
   */
  clearStalePairPayloads?(olderThan: Date): Promise<number>;
}

/** Session-state reader. MUST return null only for a genuinely absent row. */
export interface RentalReaperSessions {
  stateOf(sessionId: string): Promise<string | null>;
  /**
   * Whether any NON-terminal session is durably linked to this license
   * (`sessions.license_id`). Used to prove an abandoned claim is safe to
   * release. Callers MUST fail safe (treat "unknown" as active).
   */
  hasActiveSessionForLicense(licenseId: string): Promise<boolean>;
}

export interface RentalReaperDeps {
  store: RentalReaperStore;
  sessions: RentalReaperSessions;
  now?: () => Date;
  abandonedGraceMs?: number;
}

export interface RentalReapResult {
  closedRentals: string[];
  releasedClaims: string[];
  /** Abandoned claims withheld because a linked session may still be live. */
  heldClaims: string[];
  skippedActive: string[];
  /** Rental-scoped pair payloads dropped by the cleanup sweep. */
  clearedPairPayloads: number;
  errors: { target: string; error: string }[];
}

/** Sentinel used when the session-state lookup itself fails: non-terminal, so
 *  the pure planner leaves the rental untouched (fail safe, never steal). */
const UNKNOWN_STATE = '__lookup_error__';

export class RentalReaper {
  private readonly store: RentalReaperStore;
  private readonly sessions: RentalReaperSessions;
  private readonly now: () => Date;
  private readonly abandonedGraceMs: number;

  constructor(deps: RentalReaperDeps) {
    this.store = deps.store;
    this.sessions = deps.sessions;
    this.now = deps.now ?? (() => new Date());
    this.abandonedGraceMs = deps.abandonedGraceMs ?? ABANDONED_CLAIM_GRACE_MS;
  }

  async reconcile(): Promise<RentalReapResult> {
    const now = this.now();
    const errors: { target: string; error: string }[] = [];

    const expired = await this.store.listExpiredOpenRentals(new Date(now.getTime() - RENTAL_GRACE_MS));

    const states = new Map<string, string | null>();
    for (const lease of expired) {
      if (states.has(lease.sessionId)) continue;
      try {
        states.set(lease.sessionId, await this.sessions.stateOf(lease.sessionId));
      } catch (err) {
        states.set(lease.sessionId, UNKNOWN_STATE);
        errors.push({ target: lease.sessionId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const staleClaims = await this.store.listStaleClaims(new Date(now.getTime() - this.abandonedGraceMs));

    // Prove each abandoned claim is safe to release. A missing rental is NOT
    // proof that no session exists — the session could have been created and
    // the rental persist could have failed. Only release when no non-terminal
    // session is linked to the license. Any lookup error is treated as "may be
    // live" so we never steal a license from a running session (fail safe).
    const activeLicenses = new Set<string>();
    for (const licenseId of staleClaims) {
      try {
        if (await this.sessions.hasActiveSessionForLicense(licenseId)) activeLicenses.add(licenseId);
      } catch (err) {
        activeLicenses.add(licenseId);
        errors.push({ target: licenseId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const plan = planRentalReap(expired, states, staleClaims, activeLicenses);

    const closedRentals: string[] = [];
    const releasedClaims: string[] = [];

    for (const lease of plan.closeRentals) {
      try {
        await this.store.closeRental(lease.rentalId, now);
        closedRentals.push(lease.rentalId);
      } catch (err) {
        // A failed teardown is retried on the next pass: the rental is still
        // open and still expired, so it reappears in the plan.
        errors.push({ target: lease.rentalId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    for (const licenseId of plan.releaseClaims) {
      try {
        await this.store.markAvailable(licenseId);
        releasedClaims.push(licenseId);
      } catch (err) {
        errors.push({ target: licenseId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Durable cleanup obligation: drop rental-scoped pair payloads from
    // already-ended rentals. A failure is retried on the next pass (the row is
    // still ended and still carries a payload).
    let clearedPairPayloads = 0;
    if (this.store.clearStalePairPayloads) {
      try {
        clearedPairPayloads = await this.store.clearStalePairPayloads(now);
      } catch (err) {
        errors.push({ target: 'pair-payload-cleanup', error: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      closedRentals,
      releasedClaims,
      heldClaims: plan.heldClaims,
      skippedActive: plan.skippedActive.map((l) => l.rentalId),
      clearedPairPayloads,
      errors,
    };
  }
}
