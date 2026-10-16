/**
 * end-session — the normal-path teardown (layer 1 of five; ADR-004). For ANY
 * end reason we: terminate the VM, revoke its Vault credential, drop the cached
 * wrap token, write a usage record, and land the session in a terminal state.
 * Idempotent: ending an already-ended session is a no-op that returns state.
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
import { writeUsageRecord, type UsageStore } from '../billing/usage.js';
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

  if (isTerminal(session.state)) {
    // Idempotent teardown. Even though the session is already terminal we
    // still ATTEMPT the rental release: a session that failed/ended without a
    // successful release would otherwise leave its license stuck `rented`
    // forever (audit finding H1). Best-effort — release must not fail an
    // already-terminal teardown.
    if (deps.marketplace) {
      await deps.marketplace.completeForSession(sid).catch(() => undefined);
    }
    // Revoke guest-provisioning authority as well (idempotent): a still-live
    // instance must not re-pull a credential for an ended session.
    await deps.guestProvisioning?.revoke(sid).catch(() => undefined);
    return {
      sessionId: sid,
      state: session.state,
      endReason: (session.endReason as EndReason | null) ?? null,
      billableSeconds: session.billableSeconds ?? 0,
      alreadyTerminal: true,
    };
  }

  // Move to terminating (legal from every non-terminal state).
  await deps.sessions.update(sid, { state: transition(session.state, 'terminate') });
  await deps.events.record(sid, 'terminating', actor, { reason });

  // Terminate the VM and account for its cost (best-effort, teardown must
  // proceed even if one sub-step fails — the reaper is the backstop).
  let hourlyCostUsd = 0;
  if (session.instanceId) {
    const inst = await deps.instances.findById(session.instanceId).catch(() => null);
    if (inst) {
      hourlyCostUsd = inst.hourlyCostUsd;
      await deps.cloud.terminateInstance(inst.cloudInstanceId).catch(() => undefined);
      await deps.instances.markState(session.instanceId, 'terminated', now).catch(() => undefined);
    }
  }

  // Revoke the credential and forget its wrap token. Revocation is retried
  // (bounded) because a transient Vault/DB hiccup must not silently leave the
  // secret staged; if every attempt fails the secret's own short TTL and the
  // single-use wrap token remain the backstop.
  try {
    await withRetries(() => deps.credentialIssuer.revoke(sid), { attempts: 3, baseDelayMs: 10 });
  } catch {
    // Best effort: teardown must still proceed to a terminal state.
  }
  deps.wrapCache.drop(sid);

  // Revoke guest-provisioning authority (bounded retry). Even a still-live
  // instance must not be able to re-pull its credential once the session ends;
  // if every attempt fails, the session's terminal DB state and the package
  // TTL remain the backstop.
  const gp = deps.guestProvisioning;
  if (gp) {
    await withRetries(() => gp.revoke(sid), { attempts: 3, baseDelayMs: 10 }).catch(() => undefined);
  }

  // Usage/billing.
  const finalSession: SessionRecord = { ...session, disconnectedAt: session.disconnectedAt ?? now, endedAt: now };
  const { billableSeconds } = await writeUsageRecord(finalSession, hourlyCostUsd, { usage: deps.usage, now: () => now });

  // Marketplace release: the rented license goes back to `available` the
  // moment its session ends — the spec's automatic offboarding ("access is
  // immediately lost with absolutely no chance of any lingering cached
  // session data or credentials").
  if (deps.marketplace) {
    await deps.marketplace.completeForSession(sid).catch(() => undefined);
  }

  // Land terminal.
  await deps.sessions.update(sid, {
    state: transition('terminating', 'ended'),
    endReason: reason,
    endedAt: now,
    disconnectedAt: session.disconnectedAt ?? now,
    billableSeconds,
  });
  await deps.events.record(sid, 'ended', actor, { reason, billableSeconds });
  await deps.audit.record({
    orgId: session.orgId,
    ...(actor ? { actorUserId: actor } : {}),
    action: 'session.end',
    targetType: 'session',
    targetId: sid,
    detail: { reason, billableSeconds },
  });

  return { sessionId: sid, state: 'ended', endReason: reason, billableSeconds, alreadyTerminal: false };
}
