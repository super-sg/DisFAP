/**
 * Guest provisioning service — authorizes and delivers a session credential to
 * a booting guest VM (audit finding C3, milestone M8).
 *
 * FLOW
 *   guest (verified instance identity) ──▶ verify() ──▶ resolve binding by
 *   verified.instanceId ──▶ evaluate(binding, record) ──▶ read credential from
 *   Vault ──▶ build package ──▶ return ONCE.
 *
 * SECURITY PROPERTIES
 *  - Authorization is server-side DATA: the binding is looked up from the
 *    pool/session records THIS control plane launched. A guest cannot name its
 *    own session; it can only present the AWS-signed identity of the instance
 *    it is, and the join decides what (if anything) that instance may receive.
 *  - A compromised guest of one session cannot retrieve another's credential:
 *    its signed document names its own instance, which maps only to its own
 *    session. There is no path to address another instance's credential.
 *  - The decision is a PURE function (`evaluateProvisioningRequest`) so every
 *    deny branch is unit-testable without I/O.
 *  - Fail closed: unknown instance, mismatched image/region, terminal session,
 *    revoked or expired record, disabled mode, missing credential — all deny.
 *  - Idempotent: repeated invocations for the same instance within TTL and
 *    below the delivery cap succeed (an interrupted boot may retry); a revoked
 *    or ended session does not.
 */

import { isTerminal, type SessionState } from '../state-machine.js';
import { ProvisioningPackageError, buildProvisioningPackage, type ProvisioningPackage } from './provisioning-package.js';
import {
  InstanceIdentityError,
  type InstanceIdentityVerifier,
  type PresentedInstanceIdentity,
} from './instance-identity.js';

/** The authoritative server-side binding for one instance. */
export interface GuestSessionBinding {
  sessionId: string;
  /** Marketplace license, or null for a base session. */
  licenseId: string | null;
  orgId: string;
  templateId: string;
  /** Cloud instance id the credential is authorized for. */
  instanceId: string;
  /** Expected hardened AMI for this instance. */
  imageId: string;
  /** Expected AWS region, when known. */
  region?: string;
  /** Current session lifecycle state (authorization is denied once terminal). */
  state: SessionState;
  /** Hard expiry for provisionability (≤ the credential/session TTL). */
  expiresAt: Date;
}

/** Resolves the binding for a cloud instance id. MUST return null when absent. */
export interface GuestBindingResolver {
  resolveByInstanceId(cloudInstanceId: string): Promise<GuestSessionBinding | null>;
}

/** Reads the session credential to deliver. MUST return null when unavailable. */
export interface GuestCredentialSource {
  read(sessionId: string): Promise<{ username: string; password?: string; privateKey?: string } | null>;
}

/** In-memory per-session provisioning state. Not the credential — metadata only. */
export interface ProvisioningRecord {
  sessionId: string;
  state: 'pending' | 'delivered' | 'provisioned' | 'failed' | 'revoked';
  deliveries: number;
  firstDeliveredAt: Date | null;
  lastDeliveredAt: Date | null;
  provisionedAt: Date | null;
}

export interface ProvisioningRegistry {
  get(sessionId: string): ProvisioningRecord | undefined;
  markDelivered(sessionId: string, at: Date): void;
  markProvisioned(sessionId: string, at: Date): void;
  markFailed(sessionId: string, at: Date): void;
  revoke(sessionId: string, at: Date): void;
}

export class InMemoryProvisioningRegistry implements ProvisioningRegistry {
  private readonly rows = new Map<string, ProvisioningRecord>();

  get(sessionId: string): ProvisioningRecord | undefined {
    const r = this.rows.get(sessionId);
    return r ? { ...r } : undefined;
  }

  private upsert(sessionId: string): ProvisioningRecord {
    let r = this.rows.get(sessionId);
    if (!r) {
      r = { sessionId, state: 'pending', deliveries: 0, firstDeliveredAt: null, lastDeliveredAt: null, provisionedAt: null };
      this.rows.set(sessionId, r);
    }
    return r;
  }

  markDelivered(sessionId: string, at: Date): void {
    const r = this.upsert(sessionId);
    r.state = 'delivered';
    r.deliveries += 1;
    r.firstDeliveredAt ??= at;
    r.lastDeliveredAt = at;
  }

  markProvisioned(sessionId: string, at: Date): void {
    const r = this.upsert(sessionId);
    r.state = 'provisioned';
    r.provisionedAt = at;
  }

  markFailed(sessionId: string, at: Date): void {
    const r = this.upsert(sessionId);
    r.state = 'failed';
    r.lastDeliveredAt = at;
  }

  revoke(sessionId: string, at: Date): void {
    const r = this.upsert(sessionId);
    r.state = 'revoked';
    r.lastDeliveredAt = at;
  }
}

export type GuestProvisioningMode = 'disabled' | 'instance-identity';

export type ProvisioningDenyReason =
  | 'disabled'
  | 'unknown_instance'
  | 'instance_mismatch'
  | 'image_mismatch'
  | 'region_mismatch'
  | 'session_terminal'
  | 'record_revoked'
  | 'expired'
  | 'delivery_cap'
  | 'no_credential';

export type ProvisioningDecision =
  | { allow: true; reason: 'authorized'; idempotent: boolean }
  | { allow: false; reason: ProvisioningDenyReason; status: number };

function deny(reason: ProvisioningDenyReason, status: number): ProvisioningDecision {
  return { allow: false, reason, status };
}

export interface EvaluateInput {
  mode: GuestProvisioningMode;
  identity: { instanceId: string; imageId: string; region: string };
  binding: GuestSessionBinding | null;
  record: ProvisioningRecord | undefined;
  now: Date;
  maxDeliveries: number;
}

/**
 * PURE authorization decision. Every branch is a hard deny; only the exact
 * server-side-bound instance, in a live session, within TTL and under the
 * delivery cap, is allowed.
 */
export function evaluateProvisioningRequest(input: EvaluateInput): ProvisioningDecision {
  if (input.mode !== 'instance-identity') return deny('disabled', 503);

  const binding = input.binding;
  if (!binding) return deny('unknown_instance', 403);
  if (binding.instanceId !== input.identity.instanceId) return deny('instance_mismatch', 403);
  if (binding.imageId !== input.identity.imageId) return deny('image_mismatch', 403);
  if (binding.region !== undefined && binding.region !== input.identity.region) return deny('region_mismatch', 403);

  if (binding.expiresAt.getTime() <= input.now.getTime()) return deny('expired', 403);
  if (isTerminal(binding.state)) return deny('session_terminal', 403);

  if (input.record?.state === 'revoked') return deny('record_revoked', 403);

  // The delivery cap bounds total deliveries (including interrupted-boot
  // retries), independent of idempotency: an instance cannot hammer the
  // endpoint for a credential. Default 10 leaves ample room for real retries.
  const delivered = input.record?.deliveries ?? 0;
  if (delivered >= input.maxDeliveries) return deny('delivery_cap', 429);

  const idempotent = input.record?.state === 'delivered' || input.record?.state === 'provisioned';
  return { allow: true, reason: 'authorized', idempotent };
}

export class GuestProvisioningError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'GuestProvisioningError';
    this.statusCode = statusCode;
  }
}

export interface GuestProvisioningDeps {
  mode: GuestProvisioningMode;
  verifier: InstanceIdentityVerifier;
  bindings: GuestBindingResolver;
  credentials: GuestCredentialSource;
  registry?: ProvisioningRegistry;
  /**
   * Which OS account the credential is materialized into. The license's
   * application identity is not exposed to the rentee as a shell account; the
   * OS login is a least-privilege session account and the app mapping rides in
   * `appProfile`. Default: a fixed session account name.
   */
  osUsernameFor?: (binding: GuestSessionBinding) => string;
  /** Application/profile id the license maps to, or null. */
  appProfileFor?: (binding: GuestSessionBinding) => string | null;
  /** Max credential deliveries per live session (idempotent retries included). */
  maxDeliveries?: number;
  /** Absolute ceiling on a provisioning window, seconds (default 900). */
  ttlSeconds?: number;
  now?: () => Date;
}

export class GuestProvisioningService {
  private readonly mode: GuestProvisioningMode;
  private readonly verifier: InstanceIdentityVerifier;
  private readonly bindings: GuestBindingResolver;
  private readonly credentials: GuestCredentialSource;
  private readonly registry: ProvisioningRegistry;
  private readonly osUsernameFor: (binding: GuestSessionBinding) => string;
  private readonly appProfileFor: (binding: GuestSessionBinding) => string | null;
  private readonly maxDeliveries: number;
  private readonly ttlSeconds: number;
  private readonly now: () => Date;

  constructor(deps: GuestProvisioningDeps) {
    this.mode = deps.mode;
    this.verifier = deps.verifier;
    this.bindings = deps.bindings;
    this.credentials = deps.credentials;
    this.registry = deps.registry ?? new InMemoryProvisioningRegistry();
    this.osUsernameFor = deps.osUsernameFor ?? (() => 'dfap-session');
    this.appProfileFor = deps.appProfileFor ?? (() => null);
    this.maxDeliveries = deps.maxDeliveries ?? 10;
    this.ttlSeconds = deps.ttlSeconds ?? 900;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Verify → authorize → deliver. Throws `InstanceIdentityError` (401/503) when
   * the proof cannot be trusted, and `GuestProvisioningError` (403/409/429)
   * when the (trusted) identity is not authorized. Never returns a package for
   * an unverified or unbound caller.
   */
  async provision(presented: PresentedInstanceIdentity): Promise<ProvisioningPackage> {
    if (this.mode !== 'instance-identity') {
      throw new GuestProvisioningError('guest provisioning is disabled', 503);
    }

    const identity = await this.verifier.verify(presented);

    const binding = await this.bindings.resolveByInstanceId(identity.instanceId);
    const now = this.now();
    const record = binding ? this.registry.get(binding.sessionId) : undefined;

    const decision = evaluateProvisioningRequest({
      mode: this.mode,
      identity,
      binding,
      record,
      now,
      maxDeliveries: this.maxDeliveries,
    });
    if (!decision.allow) {
      throw new GuestProvisioningError(`provisioning denied: ${decision.reason}`, decision.status);
    }
    // `decision.allow` implies a non-null binding (the only allow path).
    const bound = binding as GuestSessionBinding;

    const credential = await this.credentials.read(bound.sessionId);
    if (!credential?.password) {
      // The session credential is staged in Vault at claim time; if it is not
      // there yet the guest should retry — never fall back to anything weaker.
      throw new GuestProvisioningError('provisioning denied: no_credential', 409);
    }

    const issuedAt = now;
    const expires = new Date(Math.min(bound.expiresAt.getTime(), now.getTime() + this.ttlSeconds * 1000));
    const pkg = buildProvisioningPackage({
      sessionId: bound.sessionId,
      licenseId: bound.licenseId,
      orgId: bound.orgId,
      templateId: bound.templateId,
      instanceId: bound.instanceId,
      imageId: bound.imageId,
      osUsername: this.osUsernameFor(bound),
      osPassword: credential.password,
      appProfile: this.appProfileFor(bound),
      issuedAt,
      expiresAt: expires,
    });

    this.registry.markDelivered(bound.sessionId, now);
    return pkg;
  }

  /**
   * Optional confirmation the guest provisioned successfully. Best-effort: the
   * guest may die before calling back, so absence is not an error.
   */
  async confirmProvisioned(sessionId: string): Promise<void> {
    this.registry.markProvisioned(sessionId, this.now());
  }

  /**
   * Revoke provisioning authority for a session. Called on session teardown so
   * that even a still-live instance cannot re-pull a credential after the
   * session ended. Idempotent.
   */
  async revoke(sessionId: string): Promise<void> {
    this.registry.revoke(sessionId, this.now());
  }
}

// Re-exported so callers can catch the verifier's failure without a second import.
export { InstanceIdentityError };
export type ProvisioningPackageValidationError = ProvisioningPackageError;
