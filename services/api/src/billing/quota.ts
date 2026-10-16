/**
 * Quota enforcement — the gate `POST /sessions` calls before spending money on
 * a VM. Two independent checks:
 *
 *  1. Concurrency: active sessions < plan.maxConcurrent.
 *  2. Seat-hours: seat-seconds used this billing period < included allowance,
 *     UNLESS the plan permits overage (overagePriceCents > 0), in which case
 *     we allow it and bill the excess.
 *
 * An org with no subscription is treated as a zero-allowance free tier and is
 * refused — you cannot burn a VM without a plan.
 */

export interface PlanLimits {
  maxConcurrent: number;
  includedSeatSeconds: number;
  /** >0 means overage is allowed and metered; 0 means a hard cap. */
  overagePriceCents: number;
}

export interface QuotaStore {
  /** Sessions currently holding a VM (states requested..disconnected). */
  countActiveSessions(orgId: string): Promise<number>;
  /** Plan limits for the org, or null if it has no active subscription. */
  getLimits(orgId: string): Promise<PlanLimits | null>;
  /** Billable seat-seconds already consumed in the current period. */
  getUsedSeatSecondsThisPeriod(orgId: string): Promise<number>;
}

export type QuotaReason = 'no_subscription' | 'max_concurrent' | 'seat_hours_exhausted';

export class QuotaExceededError extends Error {
  readonly statusCode = 402; // Payment Required
  constructor(public readonly reason: QuotaReason) {
    super(`quota check failed: ${reason}`);
    this.name = 'QuotaExceededError';
  }
}

export interface QuotaDecision {
  allowed: true;
  /** True when this session will draw on metered overage rather than allowance. */
  overage: boolean;
}

/**
 * Throws `QuotaExceededError` if the org may not start a new session; otherwise
 * returns whether the session runs into overage (for billing/telemetry).
 */
export async function enforceQuota(store: QuotaStore, orgId: string): Promise<QuotaDecision> {
  const limits = await store.getLimits(orgId);
  if (!limits) throw new QuotaExceededError('no_subscription');

  const active = await store.countActiveSessions(orgId);
  if (active >= limits.maxConcurrent) throw new QuotaExceededError('max_concurrent');

  const used = await store.getUsedSeatSecondsThisPeriod(orgId);
  const overThreshold = used >= limits.includedSeatSeconds;
  if (overThreshold && limits.overagePriceCents <= 0) {
    // Hard cap: no overage allowed on this plan.
    throw new QuotaExceededError('seat_hours_exhausted');
  }

  return { allowed: true, overage: overThreshold };
}
