/**
 * Helpers shared by the Prisma repository adapters.
 *
 * `toSessionRecord` is the single place a `sessions` row becomes a domain
 * record, so a new column is added once rather than in every repo that reads a
 * session.
 */

import { SessionState as DbSessionState } from '@prisma/client';

import type { SessionRecord } from '../../ports.js';
import type { SessionState } from '../../state-machine.js';

/** Non-terminal states — a session in any of these still holds resources. */
export const ACTIVE_STATES: DbSessionState[] = [
  DbSessionState.requested,
  DbSessionState.allocating,
  DbSessionState.ready,
  DbSessionState.connected,
  DbSessionState.idle,
  DbSessionState.disconnected,
  DbSessionState.terminating,
];

/** Coerce an untyped JSON blob field to a number with a fallback. */
export function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// The Prisma row type is structurally compatible but not assignable without
// repeating every field; the explicit mapping below is the safety net.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toSessionRecord(row: any): SessionRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    userId: row.userId,
    templateId: row.templateId,
    instanceId: row.instanceId ?? null,
    licenseId: row.licenseId ?? null,
    state: row.state as SessionState,
    requestedAt: row.requestedAt,
    readyAt: row.readyAt ?? null,
    firstPixelAt: row.firstPixelAt ?? null,
    connectedAt: row.connectedAt ?? null,
    disconnectedAt: row.disconnectedAt ?? null,
    disconnectDeadlineAt: row.disconnectDeadlineAt ?? null,
    endedAt: row.endedAt ?? null,
    endReason: row.endReason ?? null,
    billableSeconds: row.billableSeconds ?? null,
    vaultCredPath: row.vaultCredPath ?? null,
    clientIp: row.clientIp ?? null,
    clientUa: row.clientUa ?? null,
  };
}
