/**
 * Append-only records: session lifecycle events (operational history) and the
 * hash-chained audit log (tamper-evident history for a tenant).
 *
 * The two have different guarantees: events are a diagnostic trail and may be
 * dropped; audit rows are chained, and each hash covers the previous one.
 */

import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

import type { AuditEntry, AuditRecorder, EventRecorder } from '../../ports.js';

export class PrismaEventRecorder implements EventRecorder {
  constructor(private readonly db: PrismaClient) {}

  async record(
    sessionId: string,
    kind: string,
    actor: string | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.db.sessionEvent.create({
      data: { sessionId, kind, actor: actor ?? null, detail: detail as Prisma.InputJsonValue },
    });
  }
}

/** Hash-chained audit writer. Each row's hash covers the previous hash. */
export class PrismaAuditRecorder implements AuditRecorder {
  constructor(private readonly db: PrismaClient) {}

  async record(entry: AuditEntry): Promise<void> {
    const prev = await this.db.auditLog.findFirst({
      where: { orgId: entry.orgId },
      orderBy: { at: 'desc' },
      select: { hash: true },
    });
    const prevHash = prev?.hash ?? null;
    const canonical = JSON.stringify({
      orgId: entry.orgId,
      actorUserId: entry.actorUserId ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      ip: entry.ip ?? null,
      detail: entry.detail,
    });
    const hash = createHash('sha256').update(`${prevHash ?? ''}\n${canonical}`).digest('hex');
    await this.db.auditLog.create({
      data: {
        orgId: entry.orgId,
        actorUserId: entry.actorUserId ?? null,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        ip: entry.ip ?? null,
        detail: entry.detail as Prisma.InputJsonValue,
        prevHash,
        hash,
      },
    });
  }
}
