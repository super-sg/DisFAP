/**
 * Ports — the narrow interfaces the lifecycle logic depends on, decoupled from
 * Prisma so the core (create-session, end-session) is unit-testable with plain
 * in-memory fakes and never needs a generated client at test time. The Prisma
 * implementations live in `src/db/prisma-repos.ts`.
 */

import type { SessionState } from './state-machine.js';
import type { PrincipalRole } from './auth/authenticator.js';

export type { SessionState };

/** Session row fields the control-plane logic reads/writes. */
export interface SessionRecord {
  id: string;
  orgId: string;
  userId: string;
  templateId: string;
  instanceId: string | null;
  /** Marketplace license this session rented, or null for base sessions. */
  licenseId: string | null;
  state: SessionState;
  requestedAt: Date;
  readyAt: Date | null;
  firstPixelAt: Date | null;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  endedAt: Date | null;
  endReason: string | null;
  billableSeconds: number | null;
  vaultCredPath: string | null;
  clientIp: string | null;
  clientUa: string | null;
}

export interface CreateSessionData {
  orgId: string;
  userId: string;
  templateId: string;
  state: SessionState;
  /** Marketplace license to durably link to this session, if any. */
  licenseId?: string;
  clientIp?: string;
  clientUa?: string;
}

/** Partial patch applied to a session row. */
export type SessionPatch = Partial<
  Pick<
    SessionRecord,
    | 'instanceId'
    | 'state'
    | 'readyAt'
    | 'firstPixelAt'
    | 'connectedAt'
    | 'disconnectedAt'
    | 'endedAt'
    | 'endReason'
    | 'billableSeconds'
    | 'vaultCredPath'
  >
>;

export interface SessionRepo {
  create(data: CreateSessionData): Promise<SessionRecord>;
  update(id: string, patch: SessionPatch): Promise<SessionRecord>;
  findById(id: string): Promise<SessionRecord | null>;
  /**
   * True when a non-terminal session is durably linked to this marketplace
   * license. The rental reaper uses this to prove a claimed license is safe to
   * release: while any linked session may still be live, the claim is held.
   */
  hasActiveForLicense(licenseId: string): Promise<boolean>;
  /**
   * Every session currently in `state`. The readiness reconciler uses this to
   * find `allocating` sessions whose VM has not yet been confirmed up.
   * Optional so lightweight test fakes need not implement it.
   */
  listByState?(state: SessionState): Promise<SessionRecord[]>;
}

export interface TemplateRecord {
  id: string;
  name?: string;
  orgId: string;
  os: 'linux' | 'windows';
  connectionProtocol: 'rdp' | 'vnc' | 'dcv';
  guacParams: Record<string, unknown>;
  idleTimeoutS: number;
  maxSessionS: number;
  recordingEnabled: boolean;
  gpu: boolean;
  active: boolean;
}

export interface TemplateRepo {
  findActiveById(id: string): Promise<TemplateRecord | null>;
  listActive?(orgId?: string): Promise<TemplateRecord[]>;
}

export interface InstanceRecord {
  id: string;
  cloudInstanceId: string;
  hourlyCostUsd: number;
  region: string;
}

export interface InstanceRepo {
  findById(id: string): Promise<InstanceRecord | null>;
  markState(id: string, state: string, at: Date): Promise<void>;
  /**
   * The cloud instance id plus the persisted connect host for a pool row.
   * The readiness reconciler reads this to describe the instance and probe its
   * gateway port. Optional so lightweight test fakes need not implement it.
   */
  findConnect?(id: string): Promise<{ cloudInstanceId: string; host: string | null } | null>;
}

export interface EventRecorder {
  record(sessionId: string, kind: string, actor: string | null, detail: Record<string, unknown>): Promise<void>;
}

export interface AuditEntry {
  orgId: string;
  actorUserId?: string;
  action: string;
  targetType: string;
  targetId: string;
  ip?: string;
  detail: Record<string, unknown>;
}

export interface AuditRecorder {
  record(entry: AuditEntry): Promise<void>;
}

/** The authenticated principal, as produced by an `Authenticator`. */
export interface CallerPrincipal {
  userId: string;
  orgId: string;
  role: PrincipalRole;
}

/**
 * Server-side membership lookup (`org_members`) — the authoritative source of a
 * principal's role. Identity may come from a trusted claim; privilege never
 * does, so this is the only thing that can confer owner/admin (audit C4).
 */
export interface MemberResolution {
  orgId: string;
  role: PrincipalRole;
}

export interface MembershipRepo {
  /** The role this user holds in this org, or null when not a member. */
  roleOf(orgId: string, userId: string): Promise<PrincipalRole | null>;
  /**
   * Resolve the caller's organization membership from server-side records.
   *
   * `orgHint` (an optional claim from a verified token) is a *selector* only:
   * the user must actually be a member of the named org, or the result is null.
   * With no hint, exactly one membership must exist; zero or multiple are
   * rejected (the latter needs an org claim to disambiguate).
   */
  resolveMembership(userId: string, orgHint?: string): Promise<MemberResolution | null>;
}

/**
 * Maps a verified external identity — the (issuer, subject) pair from a trusted
 * token — to an internal DisFAP user id. Returns null when unmapped; callers
 * MUST reject in that case (no JIT auto-provisioning). Email is never the key.
 */
export interface IdentityRepo {
  resolve(issuer: string, subject: string): Promise<string | null>;
}
