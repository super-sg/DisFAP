/**
 * Prisma-backed implementations of every control-plane port. This is the ONLY
 * module (besides `client.ts`) that imports the generated Prisma client, so the
 * rest of the codebase — and all unit tests — stay client-free and fast.
 *
 * Requires `npm run prisma:generate` before type-check / run.
 */

import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient, SessionState as DbSessionState, PoolState as DbPoolState } from '@prisma/client';

import type {
  SessionRepo,
  SessionRecord,
  CreateSessionData,
  SessionPatch,
  TemplateRepo,
  TemplateRecord,
  InstanceRepo,
  InstanceRecord,
  EventRecorder,
  AuditRecorder,
  AuditEntry,
  MembershipRepo,
  MemberResolution,
  IdentityRepo,
} from '../ports.js';
import type { PrincipalRole } from '../auth/authenticator.js';
import type { IdentityProvisioningStore } from '../auth/identity-provisioning.js';
import type { SessionState } from '../state-machine.js';
import type { QuotaStore, PlanLimits } from '../billing/quota.js';
import type { UsageStore, UsageRecordData } from '../billing/usage.js';
import type { StripeEventStore } from '../billing/webhook.js';
import type { SessionConnectStore, SessionConnectRow } from '../integration/prisma-session-resolver.js';
import type { ReaperDb, DbPoolInstance } from '../pool/reaper.js';
import type { LaunchTemplateReader, LaunchTemplateInfo } from '../pool/launch-planner.js';
import type { GuestBindingStore, GuestBindingPoolRow, GuestBindingSessionRow } from '../guest/binding-resolver.js';

/** Non-terminal states — a session in any of these still holds resources. */
const ACTIVE_STATES: DbSessionState[] = [
  DbSessionState.requested,
  DbSessionState.allocating,
  DbSessionState.ready,
  DbSessionState.connected,
  DbSessionState.idle,
  DbSessionState.disconnected,
  DbSessionState.terminating,
];

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toSessionRecord(row: any): SessionRecord {
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
    endedAt: row.endedAt ?? null,
    endReason: row.endReason ?? null,
    billableSeconds: row.billableSeconds ?? null,
    vaultCredPath: row.vaultCredPath ?? null,
    clientIp: row.clientIp ?? null,
    clientUa: row.clientUa ?? null,
  };
}

// ---------------------------------------------------------------------------

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
}

// ---------------------------------------------------------------------------

export class PrismaMembershipRepo implements MembershipRepo {
  constructor(private readonly db: PrismaClient) {}

  async roleOf(orgId: string, userId: string): Promise<PrincipalRole | null> {
    const member = await this.db.orgMember.findUnique({
      where: { orgId_userId: { orgId, userId } },
      select: { role: true },
    });
    return (member?.role as PrincipalRole | undefined) ?? null;
  }

  async resolveMembership(userId: string, orgHint?: string): Promise<MemberResolution | null> {
    // A token's org hint only selects among the memberships that actually
    // exist server-side; it never grants one.
    if (orgHint !== undefined) {
      const role = await this.roleOf(orgHint, userId);
      return role ? { orgId: orgHint, role } : null;
    }
    const memberships = await this.db.orgMember.findMany({
      where: { userId },
      select: { orgId: true, role: true },
    });
    if (memberships.length !== 1) return null; // none, or ambiguous without a hint
    const only = memberships[0]!;
    return { orgId: only.orgId, role: only.role as PrincipalRole };
  }
}

// ---------------------------------------------------------------------------

export class PrismaIdentityRepo implements IdentityRepo {
  constructor(private readonly db: PrismaClient) {}

  async resolve(issuer: string, subject: string): Promise<string | null> {
    const row = await this.db.externalIdentity.findUnique({
      where: { issuer_subject: { issuer, subject } },
      select: { userId: true },
    });
    return row?.userId ?? null;
  }
}

// ---------------------------------------------------------------------------

/**
 * Operator-only store for provisioning `external_identities` (see
 * `auth/identity-provisioning.ts` and `cli/provision-identity.ts`). Not wired
 * into any HTTP route.
 */
export class PrismaIdentityProvisioningStore implements IdentityProvisioningStore {
  constructor(private readonly db: PrismaClient) {}

  async findUserId(issuer: string, subject: string): Promise<string | null> {
    const row = await this.db.externalIdentity.findUnique({
      where: { issuer_subject: { issuer, subject } },
      select: { userId: true },
    });
    return row?.userId ?? null;
  }

  async userExists(userId: string): Promise<boolean> {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { id: true } });
    return user !== null;
  }

  async create(input: { issuer: string; subject: string; userId: string; email?: string }): Promise<void> {
    await this.db.externalIdentity.create({
      data: {
        issuer: input.issuer,
        subject: input.subject,
        userId: input.userId,
        ...(input.email !== undefined ? { email: input.email } : {}),
      },
    });
  }

  async reassign(issuer: string, subject: string, userId: string): Promise<void> {
    await this.db.externalIdentity.update({
      where: { issuer_subject: { issuer, subject } },
      data: { userId },
    });
  }
}

// ---------------------------------------------------------------------------

export class PrismaTemplateRepo implements TemplateRepo, LaunchTemplateReader {
  constructor(private readonly db: PrismaClient) {}

  async findActiveById(id: string): Promise<TemplateRecord | null> {
    const t = await this.db.workspaceTemplate.findUnique({ where: { id } });
    if (!t || !t.active) return null;
    return {
      id: t.id,
      name: t.name,
      orgId: t.orgId,
      os: t.os as 'linux' | 'windows',
      connectionProtocol: t.connectionProtocol as 'rdp' | 'vnc' | 'dcv',
      guacParams: (t.guacParams as Record<string, unknown>) ?? {},
      idleTimeoutS: t.idleTimeoutS,
      maxSessionS: t.maxSessionS,
      recordingEnabled: t.recordingEnabled,
      gpu: t.gpu,
      active: t.active,
    };
  }

  async listActive(orgId?: string): Promise<TemplateRecord[]> {
    const list = await this.db.workspaceTemplate.findMany({
      where: {
        active: true,
        ...(orgId ? { orgId } : {}),
      },
    });
    return list.map((t) => ({
      id: t.id,
      name: t.name,
      orgId: t.orgId,
      os: t.os as 'linux' | 'windows',
      connectionProtocol: t.connectionProtocol as 'rdp' | 'vnc' | 'dcv',
      guacParams: (t.guacParams as Record<string, unknown>) ?? {},
      idleTimeoutS: t.idleTimeoutS,
      maxSessionS: t.maxSessionS,
      recordingEnabled: t.recordingEnabled,
      gpu: t.gpu,
      active: t.active,
    }));
  }

  async load(templateId: string): Promise<LaunchTemplateInfo | null> {
    const t = await this.db.workspaceTemplate.findUnique({ where: { id: templateId } });
    if (!t) return null;
    return { orgId: t.orgId, gpu: t.gpu, maxSessionS: t.maxSessionS };
  }
}

// ---------------------------------------------------------------------------

export class PrismaInstanceRepo implements InstanceRepo {
  constructor(private readonly db: PrismaClient) {}

  async findById(id: string): Promise<InstanceRecord | null> {
    const i = await this.db.poolInstance.findUnique({ where: { id } });
    if (!i) return null;
    return {
      id: i.id,
      cloudInstanceId: i.cloudInstanceId,
      hourlyCostUsd: Number(i.hourlyCostUsd),
      region: i.region,
    };
  }

  async markState(id: string, state: string, at: Date): Promise<void> {
    await this.db.poolInstance.update({
      where: { id },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { state: state as any, ...(state === 'terminated' ? { terminatedAt: at } : {}) },
    });
  }

  async findConnect(id: string): Promise<{ cloudInstanceId: string; host: string | null } | null> {
    const i = await this.db.poolInstance.findUnique({
      where: { id },
      select: { cloudInstanceId: true, privateIp: true },
    });
    if (!i) return null;
    return { cloudInstanceId: i.cloudInstanceId, host: i.privateIp ?? null };
  }
}

// ---------------------------------------------------------------------------
// Guest provisioning binding resolution (audit C3 / M8)
// ---------------------------------------------------------------------------

/**
 * Server-side join from a VERIFIED cloud instance id to the session this
 * control plane launched it for. No schema change: `pool_instances.
 * cloud_instance_id` is unique and carries `claimed_by_session_id`.
 */
export class PrismaGuestBindingStore implements GuestBindingStore {
  constructor(private readonly db: PrismaClient) {}

  async findByCloudInstanceId(cloudInstanceId: string): Promise<GuestBindingPoolRow | null> {
    const i = await this.db.poolInstance.findUnique({ where: { cloudInstanceId } });
    if (!i) return null;
    return {
      poolInstanceId: i.id,
      templateId: i.templateId,
      region: i.region,
      state: i.state,
      claimedBySessionId: i.claimedBySessionId ?? null,
      expiresAt: i.expiresAt,
    };
  }

  async findSession(sessionId: string): Promise<GuestBindingSessionRow | null> {
    const s = await this.db.session.findUnique({ where: { id: sessionId } });
    if (!s) return null;
    return {
      id: s.id,
      orgId: s.orgId,
      templateId: s.templateId,
      licenseId: s.licenseId ?? null,
      state: s.state as SessionState,
    };
  }
}

// ---------------------------------------------------------------------------

export class PrismaEventRecorder implements EventRecorder {
  constructor(private readonly db: PrismaClient) {}

  async record(sessionId: string, kind: string, actor: string | null, detail: Record<string, unknown>): Promise<void> {
    await this.db.sessionEvent.create({
      data: { sessionId, kind, actor: actor ?? null, detail: detail as Prisma.InputJsonValue },
    });
  }
}

// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------

export class PrismaUsageStore implements UsageStore {
  constructor(private readonly db: PrismaClient) {}

  async createUsageRecord(data: UsageRecordData): Promise<void> {
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
  }
}

// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------

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
    };
  }

  async markConnected(sid: string, at: Date): Promise<void> {
    await this.db.session.updateMany({
      where: { id: sid, state: { in: [DbSessionState.ready, DbSessionState.disconnected, DbSessionState.idle] } },
      data: { state: DbSessionState.connected, connectedAt: at, firstPixelAt: at },
    });
  }

  async markTerminating(sid: string, _reason: string, _at: Date): Promise<void> {
    await this.db.session.updateMany({
      where: { id: sid, state: { in: ACTIVE_STATES } },
      data: { state: DbSessionState.terminating },
    });
  }
}

// ---------------------------------------------------------------------------

export class PrismaReaperDb implements ReaperDb {
  constructor(private readonly db: PrismaClient) {}

  async listActiveInstances(): Promise<DbPoolInstance[]> {
    const rows = await this.db.poolInstance.findMany({
      where: { state: { notIn: [DbPoolState.terminated] } },
      select: { id: true, cloudInstanceId: true, state: true, expiresAt: true },
    });
    return rows.map((r) => ({ id: r.id, cloudInstanceId: r.cloudInstanceId, state: r.state, expiresAt: r.expiresAt }));
  }

  async markState(cloudInstanceId: string, state: string, at: Date): Promise<void> {
    await this.db.poolInstance.updateMany({
      where: { cloudInstanceId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { state: state as any, ...(state === 'terminated' ? { terminatedAt: at } : {}) },
    });
  }
}
