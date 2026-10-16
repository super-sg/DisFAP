/**
 * Usage & cost accounting. Turns a finished session into a `usage_records` row:
 * customer-facing `billable_seconds` and our `compute_cost_usd` (COGS).
 *
 * Billing model (Phase-0):
 *  - billable_seconds = time the session was actually connected
 *    (connected_at .. disconnected_at/ended_at). A session that never connected
 *    bills zero seconds to the customer.
 *  - compute_cost_usd = instance hourly rate * max(billable, 60s) / 3600 — the
 *    60s floor is the EC2 per-minute billing minimum that burn-after-reading
 *    (ADR-004) makes an unavoidable COGS line.
 */

import type { SessionRecord } from '../ports.js';

/** EC2 bills a 1-minute minimum; every launched VM costs at least this. */
export const MIN_BILLABLE_SECONDS = 60;

export interface UsageRecordData {
  orgId: string;
  sessionId: string;
  periodStart: Date;
  periodEnd: Date;
  billableSeconds: number;
  computeCostUsd: number;
  egressBytes: number;
}

export interface UsageStore {
  createUsageRecord(data: UsageRecordData): Promise<void>;
}

/** Seconds the session was connected, clamped to >= 0. */
export function computeBillableSeconds(session: SessionRecord, now: Date): number {
  const start = session.connectedAt ?? session.readyAt;
  if (!start) return 0; // never got far enough to bill
  const end = session.disconnectedAt ?? session.endedAt ?? now;
  const seconds = Math.floor((end.getTime() - start.getTime()) / 1000);
  return Math.max(0, seconds);
}

/** Compute-cost in USD for `billableSeconds` at `hourlyCostUsd`, with the floor. */
export function computeCostUsd(billableSeconds: number, hourlyCostUsd: number): number {
  const charged = Math.max(billableSeconds, MIN_BILLABLE_SECONDS);
  return (hourlyCostUsd * charged) / 3600;
}

export interface WriteUsageDeps {
  usage: UsageStore;
  now?: () => Date;
}

/**
 * Compute and persist a usage record for a finished session. `hourlyCostUsd`
 * comes from the claimed instance; `egressBytes` from telemetry (0 in Phase-0).
 * Returns the computed numbers so the caller can also stamp the session row.
 */
export async function writeUsageRecord(
  session: SessionRecord,
  hourlyCostUsd: number,
  deps: WriteUsageDeps,
  opts: { egressBytes?: number; periodStart?: Date; periodEnd?: Date } = {},
): Promise<{ billableSeconds: number; computeCostUsd: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const billableSeconds = computeBillableSeconds(session, now);
  const cost = computeCostUsd(billableSeconds, hourlyCostUsd);

  await deps.usage.createUsageRecord({
    orgId: session.orgId,
    sessionId: session.id,
    periodStart: opts.periodStart ?? session.connectedAt ?? session.requestedAt,
    periodEnd: opts.periodEnd ?? session.endedAt ?? now,
    billableSeconds,
    computeCostUsd: cost,
    egressBytes: opts.egressBytes ?? 0,
  });

  return { billableSeconds, computeCostUsd: cost };
}
