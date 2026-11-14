/**
 * Guest binding resolver — the SERVER-SIDE half of the per-instance
 * authorization model (audit finding C3, milestone M8).
 *
 * Given the instance id from a cryptographically verified identity document
 * (`instance-identity.ts`), we look up what THIS control plane launched for that
 * instance and which session claimed it. That join is the authorization: the
 * guest never names its session, and a guest cannot address another instance's
 * binding.
 *
 * No schema change is required — `pool_instances.cloud_instance_id` is unique
 * and carries `claimed_by_session_id`; the session row carries org/template/
 * license/state. The expected AMI is supplied from configuration (Phase-0 has a
 * single configured image; per-instance image persistence is a documented
 * follow-up).
 */

import type { SessionState } from '../state-machine.js';
import type { GuestBindingResolver, GuestSessionBinding } from './guest-provisioning.js';

export interface GuestBindingPoolRow {
  poolInstanceId: string;
  templateId: string;
  region: string;
  state: string;
  claimedBySessionId: string | null;
  expiresAt: Date;
}

export interface GuestBindingSessionRow {
  id: string;
  orgId: string;
  templateId: string;
  licenseId: string | null;
  state: SessionState;
}

export interface GuestBindingStore {
  findByCloudInstanceId(cloudInstanceId: string): Promise<GuestBindingPoolRow | null>;
  findSession(sessionId: string): Promise<GuestBindingSessionRow | null>;
}

export interface BindingResolverOptions {
  /** Expected hardened AMI (Phase-0: the single configured image). */
  expectedImageId: string;
  /** Optional per-template override; must not weaken the check. */
  imageIdForTemplate?: (templateId: string) => string;
}

export class BindingResolver implements GuestBindingResolver {
  constructor(
    private readonly store: GuestBindingStore,
    private readonly opts: BindingResolverOptions,
  ) {}

  async resolveByInstanceId(cloudInstanceId: string): Promise<GuestSessionBinding | null> {
    if (!cloudInstanceId) return null;
    const inst = await this.store.findByCloudInstanceId(cloudInstanceId);
    if (!inst || !inst.claimedBySessionId) return null;

    const sess = await this.store.findSession(inst.claimedBySessionId);
    if (!sess) return null;
    // Defence in depth: the pool row and the session must agree on the template,
    // or the instance is not the one this session was launched for.
    if (inst.templateId !== sess.templateId) return null;

    const imageId = this.opts.imageIdForTemplate?.(sess.templateId) ?? this.opts.expectedImageId;
    return {
      sessionId: sess.id,
      licenseId: sess.licenseId,
      orgId: sess.orgId,
      templateId: sess.templateId,
      instanceId: cloudInstanceId,
      imageId,
      region: inst.region,
      state: sess.state,
      expiresAt: inst.expiresAt,
    };
  }
}
