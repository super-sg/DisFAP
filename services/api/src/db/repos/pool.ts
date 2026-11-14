/**
 * The VM fleet: workspace templates (which double as the launch-template
 * reader), pool instances, the reaper's view, and the verified-instance →
 * session binding used by guest provisioning.
 *
 * These share `pool_instances` / `workspace_templates`, which is why they live
 * together rather than one file per class.
 */

import { type PrismaClient, PoolState as DbPoolState } from '@prisma/client';

import type { InstanceRecord, InstanceRepo, TemplateRecord, TemplateRepo } from '../../ports.js';
import type { LaunchTemplateInfo, LaunchTemplateReader } from '../../pool/launch-planner.js';
import type { DbPoolInstance, ReaperDb } from '../../pool/reaper.js';
import type {
  GuestBindingPoolRow,
  GuestBindingSessionRow,
  GuestBindingStore,
} from '../../guest/binding-resolver.js';
import type { SessionState } from '../../state-machine.js';

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
      where: { active: true, ...(orgId ? { orgId } : {}) },
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
    return {
      orgId: t.orgId,
      gpu: t.gpu,
      os: t.os as 'windows' | 'linux',
      connectionProtocol: t.connectionProtocol as 'rdp' | 'vnc' | 'dcv',
      maxSessionS: t.maxSessionS,
    };
  }
}

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

  /**
   * Record the host the readiness reconciler proved reachable. `private_ip` is
   * the persisted "connect host" the broker dials (the pool manager already
   * prefers a public IP there), so a late-arriving public IP is written back
   * over the launch-time fallback.
   */
  async markConnectHost(id: string, host: string): Promise<void> {
    await this.db.poolInstance.update({ where: { id }, data: { privateIp: host } });
  }
}

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

/** The reaper's DB side: every instance it still needs to consider. */
export class PrismaReaperDb implements ReaperDb {
  constructor(private readonly db: PrismaClient) {}

  async listActiveInstances(): Promise<DbPoolInstance[]> {
    const rows = await this.db.poolInstance.findMany({
      where: { state: { notIn: [DbPoolState.terminated] } },
      select: { id: true, cloudInstanceId: true, state: true, expiresAt: true },
    });
    return rows.map((r) => ({
      id: r.id,
      cloudInstanceId: r.cloudInstanceId,
      state: r.state,
      expiresAt: r.expiresAt,
    }));
  }

  async markState(cloudInstanceId: string, state: string, at: Date): Promise<void> {
    await this.db.poolInstance.updateMany({
      where: { cloudInstanceId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { state: state as any, ...(state === 'terminated' ? { terminatedAt: at } : {}) },
    });
  }
}
