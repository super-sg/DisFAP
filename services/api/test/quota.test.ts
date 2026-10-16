import { describe, expect, it } from 'vitest';
import { enforceQuota, QuotaExceededError, type QuotaStore, type PlanLimits } from '../src/billing/quota.js';

function store(opts: {
  limits: PlanLimits | null;
  active?: number;
  used?: number;
}): QuotaStore {
  return {
    countActiveSessions: async () => opts.active ?? 0,
    getLimits: async () => opts.limits,
    getUsedSeatSecondsThisPeriod: async () => opts.used ?? 0,
  };
}

const PLAN: PlanLimits = { maxConcurrent: 3, includedSeatSeconds: 100, overagePriceCents: 0 };
const PLAN_WITH_OVERAGE: PlanLimits = { ...PLAN, overagePriceCents: 50 };

describe('enforceQuota', () => {
  it('refuses an org with no subscription', async () => {
    await expect(enforceQuota(store({ limits: null }), 'org_1')).rejects.toMatchObject({ reason: 'no_subscription' });
  });

  it('refuses at the concurrency ceiling', async () => {
    await expect(enforceQuota(store({ limits: PLAN, active: 3 }), 'org_1')).rejects.toMatchObject({
      reason: 'max_concurrent',
    });
  });

  it('refuses when seat-hours are exhausted on a hard-cap plan', async () => {
    await expect(enforceQuota(store({ limits: PLAN, active: 0, used: 100 }), 'org_1')).rejects.toMatchObject({
      reason: 'seat_hours_exhausted',
    });
  });

  it('allows and flags overage when the plan permits metered overage', async () => {
    const decision = await enforceQuota(store({ limits: PLAN_WITH_OVERAGE, active: 0, used: 500 }), 'org_1');
    expect(decision).toEqual({ allowed: true, overage: true });
  });

  it('allows a normal within-allowance request without overage', async () => {
    const decision = await enforceQuota(store({ limits: PLAN, active: 1, used: 10 }), 'org_1');
    expect(decision).toEqual({ allowed: true, overage: false });
  });

  it('throws QuotaExceededError with a 402 status code', async () => {
    const err = await enforceQuota(store({ limits: null }), 'org_1').catch((e) => e);
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect(err.statusCode).toBe(402);
  });
});
