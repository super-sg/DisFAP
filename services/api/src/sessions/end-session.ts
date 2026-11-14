/**
 * end-session — the single authority for full session teardown. Every path that
 * ends a session (the user, an admin, the disconnect-grace reaper, readiness
 * failure, provisioning compensation) funnels through here, so VM termination,
 * credential revocation, usage accounting, rental release and the audit trail
 * can never drift apart.
 *
 * Idempotency is a correctness property, not a nicety: a user click, a grace
 * expiry, and a security kill can race. Two mechanisms make repeated calls
 * safe:
 *
 *  - `claimTermination` is a conditional state change, so only one caller
 *    records the "terminating" event;
 *  - `finalizeEnded` is a conditional `terminating → ended` transition, so only
 *    one caller records usage/audit. Every other teardown step (cloud
 *    termination, Vault delete, wrap drop, rental release) is already
 *    idempotent, which lets a failed attempt be retried by the reaper.
 *
 * The usage write is additionally guarded by a unique `session_id`, so even a
 * partial attempt that wrote usage but failed to finalize cannot double-bill.
 */

import { transition, isTerminal } from '../state-machine.js';
import type {
  SessionRepo,
  InstanceRepo,
  EventRecorder,
  AuditRecorder,
  SessionRecord,
} from '../ports.js';
import type { CloudProvider } from '../cloud/provider.js';
import type { CredentialIssuer } from '../credentials/credential-issuer.js';
import type { WrapTokenCache } from '../vault/wrap-token-cache.js';
import { computeBillableSeconds, writeUsageRecord, type UsageStore } from '../billing/usage.js';
import { withRetries } from '../util/retry.js';
import { NotFoundError } from './create-session.js';

export type EndReason = 'user' | 'idle_timeout' | 'max_duration' | 'admin' | 'error' | 'spot_interruption' | 'orphan_reaped';

/** Marketplace release seam: closes the rental tied to this session. */
export interface RentalReleaser {
  completeForSession(sessionId: string): Promise<void>;
}

export interface EndSessionDeps {
  sessions: SessionRepo;
  instances: InstanceRepo;
  cloud: CloudProvider;
  credentialIssuer: CredentialIssuer;
  wrapCache: WrapTokenCache;
  usage: UsageStore;
  events: EventRecorder;
  audit: AuditRecorder;
  /** Releases a rented marketplace license once its pixel session ends. */
  marketplace?: RentalReleaser;
  /**
   * Guest provisioning authority (audit C3 / M8). Revoked on teardown so an
   * instance cannot re-pull its credential after the session ends. Optional:
   * absent when guest provisioning is disabled.
   */
  guestProvisioning?: { revoke(sessionId: string): Promise<void> };
  now?: () => Date;
}

export interface EndSessionResult {
  sessionId: string;
  state: SessionRecord['state'];
  endReason: EndReason | null;
  billableSeconds: number;
  alreadyTerminal: boolean;
}

export async function endSession(
  sid: string,
  reason: EndReason,
  actor: string | null,
  deps: EndSessionDeps,
): Promise<EndSessionResult> {
  const now = (deps.now ?? (() => new Date()))();
  const session = await deps.sessions.findById(sid);
  if (!session) throw new NotFoundError(`session ${sid} not found`);

  if (isTerminal(session.state)) return finishTerminal(session, deps);

  // Atomically claim teardown. A concurrent caller that loses the race still
  // runs the (idempotent) cleanup below; it just does not own the one-time
  // events. If the row changed to terminal under us, stop here.
  const claimed = deps.sessions.claimTermination
    ? await deps.sessions.claimTermination(sid, now)
    : await fallbackClaim(deps, session, now);
  if (claimed) {
    await deps.events.record(sid, 'terminating', actor, { reason }).catch(() => undefined);
  }

  const claimedSession = (await deps.sessions.findById(sid)) ?? session;
  if (isTerminal(claimedSession.state)) return finishTerminal(claimedSession, deps);

  // Terminate the VM and account for its cost (best-effort, teardown must
  // proceed even if one sub-step fails — the reaper is the backstop).
  let hourlyCostUsd = 0;
  if (claimedSession.instanceId) {
    const inst = await deps.instances.findById(claimedSession.instanceId).catch(() => null);
    if (inst) {
      hourlyCostUsd = inst.hourlyCostUsd;
      await deps.cloud.terminateInstance(inst.cloudInstanceId).catch(() => undefined);
      await deps.instances.markState(claimedSession.instanceId, 'terminated', now).catch(() => undefined);
    }
  }

  // Revoke the credential and forget every outstanding wrap handle. Revocation
  // is retried (bounded) because a transient Vault/DB hiccup must not silently
  // leave the secret staged; if every attempt fails the secret's own short TTL
  // remains the backstop.
  try {
    await withRetries(() => deps.credentialIssuer.revoke(sid), { attempts: 3, baseDelayMs: 10 });
  } catch {
    // Best effort: teardown must still proceed to a terminal state.
  }
  deps.wrapCache.drop(sid);

  // Revoke guest-provisioning authority (bounded retry). Even a still-live
  // instance must not be able to re-pull its credential once the session ends.
  const gp = deps.guestProvisioning;
  if (gp) {
    await withRetries(() => gp.revoke(sid), { attempts: 3, baseDelayMs: 10 }).catch(() => undefined);
  }

  // Usage/billing. `disconnectedAt` is pinned on first teardown so a retry
  // computes the same billable window; the usage row itself is written once
  // (unique session_id) even if two callers race.
  const disconnectedAt = claimedSession.disconnectedAt ?? now;
  const finalSession: SessionRecord = { ...claimedSession, disconnectedAt, endedAt: now };
  let billableSeconds = computeBillableSeconds(finalSession, now);
  let usageRecorded = true;
  try {
    const alreadyRecorded = deps.usage.hasForSession ? await deps.usage.hasForSession(sid) : false;
    if (!alreadyRecorded) {
      ({ billableSeconds } = await writeUsageRecord(finalSession, hourlyCostUsd, { usage: deps.usage, now: () => now }));
    }
  } catch {
    // Do NOT land `ended` without the usage row: that would silently under-bill
    // and there would be no durable record left to retry from. Stay in
    // `terminating` (VM/credential cleanup above already ran and is idempotent)
    // so the reaper's stuck-teardown pass retries this exact step.
    usageRecorded = false;
  }

  // Marketplace release: the rented license goes back to `available` the
  // moment its session ends — the spec's automatic offboarding. Idempotent on
  // the store side (`endedAt ?? now`, status available).
  if (deps.marketplace) {
    await deps.marketplace.completeForSession(sid).catch(() => undefined);
  }

  if (!usageRecorded) {
    return {
      sessionId: sid,
      state: 'terminating',
      endReason: null,
      billableSeconds,
      alreadyTerminal: false,
    };
  }

  // Land terminal. Only the winner of this conditional transition emits the
  // one-time end event + audit entry.
  const patch = {
    state: 'ended' as const,
    endReason: reason,
    endedAt: now,
    disconnectedAt,
    disconnectDeadlineAt: null,
    billableSeconds,
  };
  const finalized = deps.sessions.finalizeEnded
    ? await deps.sessions.finalizeEnded(sid, patch)
    : await fallbackFinalize(deps, sid, patch);

  if (finalized) {
    await deps.events.record(sid, 'ended', actor, { reason, billableSeconds }).catch(() => undefined);
    await deps.audit
      .record({
        orgId: claimedSession.orgId,
        ...(actor ? { actorUserId: actor } : {}),
        action: 'session.end',
        targetType: 'session',
        targetId: sid,
        detail: { reason, billableSeconds },
      })
      .catch(() => undefined);
  }

  const persisted = await deps.sessions.findById(sid).catch(() => null);
  return {
    sessionId: sid,
    state: persisted?.state ?? 'ended',
    endReason: (persisted?.endReason as EndReason | null) ?? reason,
    billableSeconds: persisted?.billableSeconds ?? billableSeconds,
    alreadyTerminal: false,
  };
}

/**
 * Already-terminal path. Even though there is nothing to tear down we still
 * ATTEMPT the rental release: a session that failed/ended without a successful
 * release would otherwise leave its license stuck `rented` forever (audit H1).
 * Best-effort — release must not fail an already-terminal teardown.
 */
async function finishTerminal(session: SessionRecord, deps: EndSessionDeps): Promise<EndSessionResult> {
  if (deps.marketplace) await deps.marketplace.completeForSession(session.id).catch(() => undefined);
  await deps.guestProvisioning?.revoke(session.id).catch(() => undefined);
  return {
    sessionId: session.id,
    state: session.state,
    endReason: (session.endReason as EndReason | null) ?? null,
    billableSeconds: session.billableSeconds ?? 0,
    alreadyTerminal: true,
  };
}

/** Non-atomic fallback for minimal repositories (tests); real adapters implement the port. */
async function fallbackClaim(deps: EndSessionDeps, session: SessionRecord, at: Date): Promise<boolean> {
  if (session.state === 'terminating') return false;
  await deps.sessions.update(session.id, {
    state: transition(session.state, 'terminate'),
    disconnectedAt: session.disconnectedAt ?? at,
    disconnectDeadlineAt: null,
  });
  return true;
}

async function fallbackFinalize(
  deps: EndSessionDeps,
  sid: string,
  patch: Parameters<NonNullable<SessionRepo['finalizeEnded']>>[1],
): Promise<boolean> {
  await deps.sessions.update(sid, patch);
  return true;
}
