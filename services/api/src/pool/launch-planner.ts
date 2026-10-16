/**
 * Launch planner — turns a workspace template id into a concrete `LaunchSpec`
 * (which AMI/instance-type, which region, when it must expire) plus the hourly
 * cost we record for billing. Kept behind a narrow reader port so it needs no
 * Prisma client and is easy to fake in tests.
 */

import type { LaunchSpec } from '../cloud/provider.js';
import type { PoolLaunchPlanner } from './pool-manager.js';

export interface LaunchTemplateInfo {
  orgId: string;
  gpu: boolean;
  /** Max session lifetime; drives the hard `expires_at`. */
  maxSessionS: number;
}

export interface LaunchTemplateReader {
  load(templateId: string): Promise<LaunchTemplateInfo | null>;
}

export interface LaunchPlannerConfig {
  region: string;
  az?: string;
  /** Hardened AMI to boot (Phase-0 placeholder; Terraform-owned in Phase-1). */
  imageId: string;
  instanceType: string;
  gpuInstanceType: string;
  hourlyCostUsd: number;
  gpuHourlyCostUsd: number;
  /** Slack added to max_session_s so the reaper never races a live session. */
  expiryBufferS: number;
}

export class TemplateNotFoundError extends Error {
  constructor(templateId: string) {
    super(`template ${templateId} not found while planning launch`);
    this.name = 'TemplateNotFoundError';
  }
}

export class ConfiguredLaunchPlanner implements PoolLaunchPlanner {
  constructor(
    private readonly reader: LaunchTemplateReader,
    private readonly config: LaunchPlannerConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async plan(templateId: string, sessionId: string): Promise<{ spec: LaunchSpec; hourlyCostUsd: number }> {
    const info = await this.reader.load(templateId);
    if (!info) throw new TemplateNotFoundError(templateId);

    const expiresAt = new Date(this.now().getTime() + (info.maxSessionS + this.config.expiryBufferS) * 1000);
    const spec: LaunchSpec = {
      templateId,
      region: this.config.region,
      ...(this.config.az !== undefined ? { az: this.config.az } : {}),
      imageId: this.config.imageId,
      instanceType: info.gpu ? this.config.gpuInstanceType : this.config.instanceType,
      sessionId,
      orgId: info.orgId,
      expiresAt,
    };
    return { spec, hourlyCostUsd: info.gpu ? this.config.gpuHourlyCostUsd : this.config.hourlyCostUsd };
  }
}
