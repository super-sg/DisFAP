/**
 * Session persistence: the CRUD repo and the write paths the broker uses when a
 * tunnel connects or tears down. Both live together because they act on the same
 * `sessions` table and must agree on which states are considered live.
 */

import { Prisma, type PrismaClient, SessionState as DbSessionState } from '@prisma/client';

import type { CreateSessionData, SessionPatch, SessionRecord, SessionRepo } from '../../ports.js';
import type { SessionState } from '../../state-machine.js';
import type { SessionConnectRow, SessionConnectStore } from '../../integration/prisma-session-resolver.js';
import { ACTIVE_STATES, num, toSessionRecord } from './shared.js';

/**
 * States a teardown may claim. `terminating` is deliberately absent: a session
 * already there is either mid-teardown or awaiting the reaper's retry, and
 * `finalizeEnded` (not the claim) owns that path.
 */
const CLAIMABLE_STATES: DbSessionState[] = [
  DbSessionState.requested,
  DbSessionState.allocating,
  DbSessionState.ready,
  DbSessionState.connected,
  DbSessionState.idle,
  DbSessionState.disconnected,
];

export class PrismaSessionRepo implements SessionRepo {
  constructor(private readonly db: PrismaClient) {}

  async create(data: CreateSessionData): Promise<SessionRecord> {
    const row = await this.db.session.create({
      data: {
        orgId: data.orgId,
        userId: data.userId,
        templateId: data.templateId,
        state: data.state as DbSessionState,
        ...(data.licenseId !== undefined ? { licenseId: data.licenseId } : {}),
        ...(data.clientIp !== undefined ? { clientIp: data.clientIp } : {}),
        ...(data.clientUa !== undefined ? { clientUa: data.clientUa } : {}),
      },
    });
    return toSessionRecord(row);
  }

  async update(id: string, patch: SessionPatch): Promise<SessionRecord> {
    const data = patch as unknown as Prisma.SessionUpdateInput;
    const row = await this.db.session.update({ where: { id }, data });
    return toSessionRecord(row);
  }

  async findById(id: string): Promise<SessionRecord | null> {
    const row = await this.db.session.findUnique({ where: { id } });
    return row ? toSessionRecord(row) : null;
  }

  async listByState(state: SessionState): Promise<SessionRecord[]> {
    const rows = await this.db.session.findMany({ where: { state: state as DbSessionState } });
    return rows.map((row) => toSessionRecord(row));
  }

  async hasActiveForLicense(licenseId: string): Promise<boolean> {
    const row = await this.db.session.findFirst({
      where: { licenseId, state: { in: ACTIVE_STATES } },
      select: { id: true },
    });
    return row !== null;
  }

  // ── Idempotent teardown primitives ────────────────────────────────────────
  // Both are compare-and-set: the read only computes the patch, and the write
  // is conditional on the state that was read. A concurrent caller therefore
  // observes `count === 0` instead of overwriting the winner.

  async claimTermination(id: string, at: Date): Promise<boolean> {
    const row = await this.db.session.findUnique({
      where: { id },
      select: { state: true, disconnectedAt: true },
    });
    if (!row || !CLAIMABLE_STATES.includes(row.state)) return false;
    const res = await this.db.session.updateMany({
      where: { id, state: row.state },
      data: {
        state: DbSessionState.terminating,
        disconnectedAt: row.disconnectedAt ?? at,
        disconnectDeadlineAt: null,
      },
    });
    return res.count === 1;
  }

  async finalizeEnded(id: string, patch: SessionPatch): Promise<boolean> {
    const data = patch as unknown as Prisma.SessionUpdateInput;
    const res = await this.db.session.updateMany({
      where: { id, state: DbSessionState.terminating },
      data,
    });
    return res.count === 1;
  }

  // ── Lifecycle reaper queries (indexed) ────────────────────────────────────

  async listDisconnectedExpired(now: Date, limit: number): Promise<SessionRecord[]> {
    const rows = await this.db.session.findMany({
      where: {
        state: DbSessionState.disconnected,
        disconnectDeadlineAt: { not: null, lte: now },
      },
      orderBy: { disconnectDeadlineAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => toSessionRecord(row));
  }

  async claimExpiredDisconnect(id: string, now: Date): Promise<boolean> {
    const res = await this.db.session.updateMany({
      where: {
        id,
        state: DbSessionState.disconnected,
        disconnectDeadlineAt: { not: null, lte: now },
      },
      data: { state: DbSessionState.terminating, disconnectDeadlineAt: null },
    });
    return res.count === 1;
  }

  async listTerminatingBefore(cutoff: Date, limit: number): Promise<SessionRecord[]> {
    const rows = await this.db.session.findMany({
      where: {
        state: DbSessionState.terminating,
        disconnectedAt: { not: null, lte: cutoff },
      },
      orderBy: { disconnectedAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => toSessionRecord(row));
  }
}

/**
 * Broker-side view of a connectable session. `host` is the persisted connect
 * host on the claimed pool instance — `null` means "not dialable yet", and the
 * resolver refuses rather than guessing.
 */
export class PrismaSessionConnectStore implements SessionConnectStore {
  constructor(private readonly db: PrismaClient) {}

  async loadForConnect(sid: string): Promise<SessionConnectRow | null> {
    const s = await this.db.session.findUnique({ where: { id: sid }, include: { template: true } });
    if (!s) return null;
    let host: string | null = null;
    if (s.instanceId) {
      const inst = await this.db.poolInstance.findUnique({ where: { id: s.instanceId } });
      host = inst?.privateIp ?? null;
    }
    const g = (s.template.guacParams as Record<string, unknown>) ?? {};
    return {
      sid: s.id,
      state: s.state as SessionState,
      org: s.orgId,
      sub: s.userId,
      protocol: s.template.connectionProtocol as 'rdp' | 'vnc' | 'dcv',
      host,
      width: num(g['width'], 1920),
      height: num(g['height'], 1080),
      dpi: num(g['dpi'], 96),
      recordingEnabled: s.template.recordingEnabled,
      disconnectDeadlineAt: s.disconnectDeadlineAt ?? null,
    };
  }

  /**
   * Claim the session for this tunnel. The conditional update is the race
   * breaker with the grace reaper: whichever of `disconnected → connected`
   * (this) or `disconnected → terminating` (reaper) lands first wins, and the
   * loser observes `count === 0` and must refuse.
   *
   * `connected` is accepted so a broker/API restart can re-attach to a session
   * the database still believes is connected.
   */
  async markConnected(sid: string, at: Date): Promise<boolean> {
    const row = await this.db.session.findUnique({
      where: { id: sid },
      select: { state: true, connectedAt: true, firstPixelAt: true, disconnectDeadlineAt: true },
    });
    if (!row) return false;

    const reconnectable =
      row.state === DbSessionState.ready ||
      row.state === DbSessionState.idle ||
      row.state === DbSessionState.connected ||
      (row.state === DbSessionState.disconnected &&
        row.disconnectDeadlineAt !== null &&
        row.disconnectDeadlineAt.getTime() > at.getTime());
    if (!reconnectable) return false;

    const res = await this.db.session.updateMany({
      where: {
        id: sid,
        state: row.state,
        ...(row.state === DbSessionState.disconnected
          ? { disconnectDeadlineAt: { gt: at } }
          : {}),
      },
      data: {
        state: DbSessionState.connected,
        connectedAt: row.connectedAt ?? at,
        firstPixelAt: row.firstPixelAt ?? at,
        disconnectDeadlineAt: null,
      },
    });
    return res.count === 1;
  }

  /**
   * Record a recoverable tunnel drop. Only a live streaming session becomes
   * `disconnected`; a duplicate close event is a no-op, so the first deadline
   * is the one that governs the grace period.
   */
  async markDisconnected(sid: string, at: Date, deadline: Date): Promise<boolean> {
    const res = await this.db.session.updateMany({
      where: { id: sid, state: { in: [DbSessionState.connected, DbSessionState.idle] } },
      data: {
        state: DbSessionState.disconnected,
        disconnectedAt: at,
        disconnectDeadlineAt: deadline,
      },
    });
    return res.count === 1;
  }

  /**
   * Security-fatal termination. No grace window is granted: the session moves
   * straight to `terminating`, and the lifecycle reaper completes the VM
   * cleanup through `endSession`. `disconnectedAt` is pinned (if unset) so
   * billing stops at the kill, and the reaper's retry window is well defined.
   */
  async markTerminating(sid: string, _reason: string, at: Date): Promise<void> {
    const row = await this.db.session.findUnique({
      where: { id: sid },
      select: { state: true, disconnectedAt: true },
    });
    if (!row || !ACTIVE_STATES.includes(row.state)) return;
    await this.db.session.updateMany({
      where: { id: sid, state: row.state },
      data: {
        state: DbSessionState.terminating,
        disconnectedAt: row.disconnectedAt ?? at,
        disconnectDeadlineAt: null,
      },
    });
  }
}
