/**
 * create-session — the money path. Authenticated caller asks for a workspace;
 * we check quota, claim/launch a burn-after-reading VM, stage its credential in
 * Vault, persist the session, and mint a DFAP1 connect token.
 *
 * CRITICAL CONTRACT: the token is minted with `mintConnectToken` imported from
 * `@disfap/broker` — the exact function the broker verifies with. We never
 * reimplement the HMAC scheme, and the token carries a session id and identity
 * ONLY: no host, no port, no credential (ADR-002).
 */

import { createHash } from 'node:crypto';
import { mintConnectToken } from '@disfap/broker/src/session-token.js';
import type { Keyring } from '@disfap/broker/src/session-token.js';

import { transition } from '../state-machine.js';
import type { CallerPrincipal, SessionRepo, TemplateRepo, InstanceRepo, EventRecorder, AuditRecorder } from '../ports.js';
import type { QuotaStore } from '../billing/quota.js';
import { enforceQuota } from '../billing/quota.js';
import type { ClaimResult } from '../pool/pool-manager.js';
import type { CloudProvider } from '../cloud/provider.js';
import type { PreBootCredential } from '../cloud/disk-injector.js';
import type { CredentialIssuer } from '../credentials/credential-issuer.js';
import { generateSessionCredential, type SessionCredentialMaterial } from '../credentials/credential-issuer.js';
import type { WrapTokenCache } from '../vault/wrap-token-cache.js';

export class NotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends Error {
  readonly statusCode = 403;
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** Just enough of the pool manager for this module (keeps tests light). */
export interface SessionPool {
  claim(templateId: string, sessionId: string, preBoot?: PreBootCredential | undefined): Promise<ClaimResult>;
}

export interface CreateSessionConfig {
  brokerUrl: string;
  connectTokenTtlS: number;
  credentialTtlS: number;
}

/**
 * Server-minted (never client-supplied) authorization to launch a template
 * that belongs to another org, because the caller holds the marketplace rental
 * that licenses it. Produced by the layer-3 orchestrator after its atomic
 * claim; `createSession` re-validates it against the store before honoring it.
 */
export interface TemplateGrant {
  licenseId: string;
}

/** The store capability `createSession` uses to validate a cross-org grant. */
export interface MarketplaceTemplateGrants {
  isLicensedTo(licenseId: string, renteeId: string, templateId: string): Promise<boolean>;
}

export interface CreateSessionDeps {
  sessions: SessionRepo;
  templates: TemplateRepo;
  quota: QuotaStore;
  pool: SessionPool;
  credentialIssuer: CredentialIssuer;
  wrapCache: WrapTokenCache;
  events: EventRecorder;
  audit: AuditRecorder;
  keyring: Keyring;
  config: CreateSessionConfig;
  /** Validates cross-org marketplace grants. Absent ⇒ cross-org is forbidden. */
  templateGrants?: MarketplaceTemplateGrants;
  /** Terminates a launched VM when a later step fails (best-effort cleanup). */
  cloud?: CloudProvider;
  /** Records the pool instance as terminated during cleanup. */
  instances?: InstanceRepo;
  /**
   * When true, do NOT assume readiness after launch: leave the session in
   * `allocating` (with its instance + vault path recorded) and let the
   * readiness reconciler flip it to `ready` once the cloud confirms the VM is
   * running and its gateway port is reachable. Default false preserves the
   * immediate-ready behavior tests and warm-pool paths rely on.
   */
  deferReadiness?: boolean;
  now?: () => Date;
}

export interface CreateSessionInput {
  templateId: string;
  /** Durable marketplace license link, set only by the layer-3 orchestrator. */
  licenseId?: string;
  clientIp?: string;
  clientUa?: string;
  /**
   * Credential the VM must be logged in with. `undefined` → a fresh random
   * per-session credential is minted (the default base-workspace flow). The
   * layer-3 orchestrator passes the DECRYPTED license credential here so the
   * rentee's session boots into the licensed software.
   */
  credential?: SessionCredentialMaterial;
  /**
   * Marketplace authorization for a template owned by another org. Set ONLY by
   * the layer-3 orchestrator (never by an HTTP handler from request data).
   */
  templateGrant?: TemplateGrant;
}

export interface CreateSessionResult {
  sessionId: string;
  token: string;
  brokerUrl: string;
  expiresAt: string; // ISO — the connect token's expiry
}

/**
 * Advisory channel binding hash the broker may cross-check at connect: the
 * first 16 hex chars of sha256(ipPrefix | userAgent). Best-effort — only
 * computed when we actually know the client's ip and UA.
 */
function channelBinding(clientIp?: string, clientUa?: string): string | undefined {
  if (!clientIp || !clientUa) return undefined;
  const ipPrefix = clientIp.includes('.') ? clientIp.split('.').slice(0, 3).join('.') : clientIp;
  return createHash('sha256').update(`${ipPrefix}|${clientUa}`).digest('hex').slice(0, 16);
}

export async function createSession(
  principal: CallerPrincipal,
  input: CreateSessionInput,
  deps: CreateSessionDeps,
): Promise<CreateSessionResult> {
  const now = deps.now ?? (() => new Date());

  // 1. Template must exist and be active. It must belong to the caller's org
  //    UNLESS a validated marketplace grant authorizes it: the store must
  //    confirm this exact template is licensed to this rentee (audit C2).
  const template = await deps.templates.findActiveById(input.templateId);
  if (!template) throw new NotFoundError(`workspace template ${input.templateId} not found or inactive`);
  if (template.orgId !== principal.orgId) {
    const grant = input.templateGrant;
    const licensed =
      grant !== undefined && deps.templateGrants !== undefined
        ? await deps.templateGrants.isLicensedTo(grant.licenseId, principal.userId, template.id)
        : false;
    if (!licensed) throw new ForbiddenError('template belongs to another org');
  }

  // 2. Quota + concurrency gate BEFORE we spend money on a VM.
  await enforceQuota(deps.quota, principal.orgId);

  // 3. Create the session row (state = requested) to obtain the id we tag the
  //    VM and Vault path with.
  const session = await deps.sessions.create({
    orgId: principal.orgId,
    userId: principal.userId,
    templateId: template.id,
    state: 'requested',
    ...(input.licenseId !== undefined ? { licenseId: input.licenseId } : {}),
    ...(input.clientIp !== undefined ? { clientIp: input.clientIp } : {}),
    ...(input.clientUa !== undefined ? { clientUa: input.clientUa } : {}),
  });
  const sid = session.id;
  await deps.events.record(sid, 'requested', principal.userId, { templateId: template.id });

  // Hoisted so the failure path can clean up a VM that was already launched.
  let claim: ClaimResult | undefined;

  try {
    // 4. requested -> allocating, then claim/launch the VM.
    await deps.sessions.update(sid, { state: transition('requested', 'allocate') });
    claim = await deps.pool.claim(template.id, sid, input.credential);

    // 5. Stage the per-session credential in Vault; keep the single-use wrap
    //    token in-process (never in Postgres). Persist only the Vault path.
    const credential = input.credential ?? generateSessionCredential(template.os === 'windows' ? 'dfap-admin' : 'dfap-user');
    const issued = await deps.credentialIssuer.issue(sid, credential, deps.config.credentialTtlS);
    // Cache the wrap token for the credential's whole TTL. A real cold start
    // (image install + RDP bring-up) can take minutes, and readiness is only
    // reported once the VM is genuinely up (see pool/readiness.ts); the DFAP1
    // handle is re-minted on every getSession poll, so only this in-process
    // wrap token must outlive the wait.
    deps.wrapCache.put(sid, issued.wrapToken, deps.config.credentialTtlS);

    await deps.audit.record({
      orgId: principal.orgId,
      actorUserId: principal.userId,
      action: 'session.create',
      targetType: 'session',
      targetId: sid,
      ...(input.clientIp !== undefined ? { ip: input.clientIp } : {}),
      detail: { templateId: template.id, instanceId: claim.instance.id },
    });

    // 7. Mint the DFAP1 connect token (broker-owned function). Session id +
    //    identity only.
    const nowS = Math.floor(now().getTime() / 1000);
    const cbh = channelBinding(input.clientIp, input.clientUa);
    const token = mintConnectToken(
      {
        sid,
        sub: principal.userId,
        org: principal.orgId,
        ttlSeconds: deps.config.connectTokenTtlS,
        now: nowS,
        ...(cbh !== undefined ? { cbh } : {}),
      },
      deps.keyring,
    );
    const expiresAt = new Date((nowS + deps.config.connectTokenTtlS) * 1000).toISOString();

    // 6. When readiness is NOT deferred (tests / warm-pool / trusted path) the
    //    session is `ready` as soon as the instance is claimed. On the real-AWS
    //    evaluation path `deferReadiness` keeps it `allocating` until the
    //    readiness reconciler confirms AWS reports the VM running AND its
    //    gateway port accepts a connection — never a fabricated ready.
    if (deps.deferReadiness) {
      await deps.sessions.update(sid, { instanceId: claim.instance.id, vaultCredPath: issued.vaultPath });
      await deps.events.record(sid, 'allocating', principal.userId, {
        instanceId: claim.instance.id,
        coldLaunched: claim.coldLaunched,
      });
      return { sessionId: sid, token, brokerUrl: deps.config.brokerUrl, expiresAt };
    }

    const readyAt = now();
    await deps.sessions.update(sid, {
      instanceId: claim.instance.id,
      state: transition('allocating', 'ready'),
      readyAt,
      vaultCredPath: issued.vaultPath,
    });

    await deps.events.record(sid, 'ready', principal.userId, {
      instanceId: claim.instance.id,
      coldLaunched: claim.coldLaunched,
    });

    return { sessionId: sid, token, brokerUrl: deps.config.brokerUrl, expiresAt };
  } catch (err) {
    // Compensation for a failure AFTER the VM was launched: terminate it and
    // mark the pool row gone. If the cloud/instances deps are absent, or this
    // best-effort cleanup itself fails, the `pool_instances` row (with its
    // hard `expires_at`) plus the `failed` session remain the recoverable
    // cleanup obligation the layer-4 reaper acts on.
    const vmCleanedUp = claim !== undefined ? await cleanupLaunchedInstance(deps, claim, now()).then(() => true).catch(() => false) : false;

    // Any failure after row creation lands the session in `failed` so the
    // reaper/end path can clean up. Never leak the underlying credential/error.
    await deps.sessions.update(sid, { state: 'failed', endReason: 'error', endedAt: now() }).catch(() => undefined);
    await deps.events
      .record(sid, 'failed', principal.userId, {
        message: err instanceof Error ? err.message : 'error',
        vmCleanedUp,
      })
      .catch(() => undefined);
    throw err;
  }
}

/**
 * Best-effort termination of a VM whose session failed to become ready.
 * Exported for testing. Rejects if any step rejects so the caller can record
 * whether cleanup actually happened (observability, not silent success).
 */
export async function cleanupLaunchedInstance(
  deps: Pick<CreateSessionDeps, 'cloud' | 'instances'>,
  claim: ClaimResult,
  at: Date,
): Promise<void> {
  if (deps.cloud) await deps.cloud.terminateInstance(claim.instance.cloudInstanceId);
  if (deps.instances) await deps.instances.markState(claim.instance.id, 'terminated', at);
}
