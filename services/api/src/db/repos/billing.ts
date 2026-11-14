/**
 * Metering and billing persistence: plan limits and seat-second usage, the
 * per-session usage ledger, and Stripe webhook idempotency.
 *
 * `insertIfNew` is the idempotency gate for webhooks: a replay is recognised by
 * a unique violation on `stripe_event_id`, not by a read-then-write race.
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import type { PlanLimits, QuotaStore } from '../../billing/quota.js';
import type { UsageRecordData, UsageStore } from '../../billing/usage.js';
import type { StripeEventStore } from '../../billing/webhook.js';
import { ACTIVE_STATES } from './shared.js';

export class PrismaQuotaStore implements QuotaStore {
  constructor(private readonly db: PrismaClient) {}

  async countActiveSessions(orgId: string): Promise<number> {
    return this.db.session.count({ where: { orgId, state: { in: ACTIVE_STATES } } });
  }

  async getLimits(orgId: string): Promise<PlanLimits | null> {
    const sub = await this.db.subscription.findUnique({ where: { orgId }, include: { plan: true } });
    if (!sub || (sub.status !== 'active' && sub.status !== 'trialing')) return null;
    return {
      maxConcurrent: sub.plan.maxConcurrent,
      includedSeatSeconds: sub.plan.includedSeatHours * 3600,
      overagePriceCents: sub.plan.overagePriceCents,
    };
  }

  async getUsedSeatSecondsThisPeriod(orgId: string): Promise<number> {
    const sub = await this.db.subscription.findUnique({ where: { orgId } });
    const gte = sub?.currentPeriodStart ?? new Date(0);
    const agg = await this.db.usageRecord.aggregate({
      _sum: { billableSeconds: true },
      where: { orgId, periodStart: { gte } },
    });
    return agg._sum.billableSeconds ?? 0;
  }
}

export class PrismaUsageStore implements UsageStore {
  constructor(private readonly db: PrismaClient) {}

  async createUsageRecord(data: UsageRecordData): Promise<void> {
    try {
      await this.db.usageRecord.create({
        data: {
          orgId: data.orgId,
          sessionId: data.sessionId,
          periodStart: data.periodStart,
          periodEnd: data.periodEnd,
          billableSeconds: data.billableSeconds,
          computeCostUsd: new Prisma.Decimal(data.computeCostUsd),
          egressBytes: BigInt(Math.round(data.egressBytes)),
        },
      });
    } catch (err) {
      // `usage_records.session_id` is unique: a concurrent or retried teardown
      // that lost the race is a no-op, never a second billable row.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
      throw err;
    }
  }

  async hasForSession(sessionId: string): Promise<boolean> {
    const row = await this.db.usageRecord.findUnique({ where: { sessionId }, select: { id: true } });
    return row !== null;
  }
}

export class PrismaStripeEventStore implements StripeEventStore {
  constructor(private readonly db: PrismaClient) {}

  async insertIfNew(stripeEventId: string, type: string, payload: Record<string, unknown>): Promise<boolean> {
    try {
      await this.db.stripeEvent.create({
        data: { stripeEventId, type, payload: payload as Prisma.InputJsonValue },
      });
      return true;
    } catch (err) {
      // Unique-violation on stripe_event_id => already processed. Any other
      // error propagates.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false;
      throw err;
    }
  }

  async markProcessed(stripeEventId: string, at: Date): Promise<void> {
    await this.db.stripeEvent.update({ where: { stripeEventId }, data: { processedAt: at } });
  }
}
