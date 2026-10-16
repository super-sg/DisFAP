/**
 * Authenticator — resolves an inbound request to an authenticated principal.
 *
 * There is deliberately NO production identity provider wired here yet: the
 * control plane ships no OIDC/JWT verifier and this milestone forbids inventing
 * one. Composition therefore selects, from config, exactly one of two adapters:
 *
 *   - `FailClosedAuthenticator` — the production default. Every request is
 *     rejected. Nothing is ever served on a self-asserted identity.
 *   - `DevHeaderAuthenticator`  — LOCAL DEVELOPMENT ONLY, explicit opt-in,
 *     refused in production by `loadConfig`. Reads an identity (user + org)
 *     from request headers and resolves the caller's ROLE from server-side
 *     records.
 *
 * Neither adapter trusts `x-dfap-role`: privilege is data, never a header.
 */

export type PrincipalRole = 'owner' | 'admin' | 'member' | 'auditor';

export interface Principal {
  userId: string;
  orgId: string;
  role: PrincipalRole;
}

/** Minimal request view the authenticator needs (Fastify request satisfies it). */
export interface AuthRequestView {
  headers: Record<string, string | string[] | undefined>;
}

export class UnauthorizedError extends Error {
  readonly statusCode = 401;
  constructor(message = 'unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/** Authenticated, but not a member of any organization it may act in. */
export class ForbiddenError extends Error {
  readonly statusCode = 403;
  constructor(message = 'forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export interface Authenticator {
  authenticate(req: AuthRequestView): Promise<Principal>;
}

/**
 * Resolves a role from authoritative server-side records (`org_members`), or
 * null when the identity holds no membership in that org. Never derived from
 * the request.
 */
export type RoleResolver = (orgId: string, userId: string) => Promise<PrincipalRole | null>;

function header(req: AuthRequestView, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

const ROLES: ReadonlySet<string> = new Set<PrincipalRole>(['owner', 'admin', 'member', 'auditor']);

/**
 * Fail closed. Composed whenever no trusted identity source is configured —
 * i.e. every real deployment until an IdP integration lands. Rejecting loudly
 * is correct: serving traffic on a client-asserted identity is the bug that
 * this replaces (audit finding C4).
 */
export class FailClosedAuthenticator implements Authenticator {
  async authenticate(): Promise<Principal> {
    throw new UnauthorizedError('authentication is not configured');
  }
}

/**
 * LOCAL DEVELOPMENT ONLY (selected by `DFAP_AUTH_MODE=dev-header`; config
 * refuses that value in production). Identity (user + org) is taken from the
 * request; this is the single place a client-asserted identity is honoured, and
 * only because the adapter cannot be composed outside local development.
 *
 * The role is resolved server-side via `resolveRole`; the `x-dfap-role` header
 * is ignored entirely, so a forged role header confers no privilege.
 */
export class DevHeaderAuthenticator implements Authenticator {
  constructor(private readonly resolveRole: RoleResolver) {}

  async authenticate(req: AuthRequestView): Promise<Principal> {
    // x-dfap-role is deliberately NOT read: privilege is never client-asserted.
    const userId = header(req, 'x-dfap-user');
    const orgId = header(req, 'x-dfap-org');
    if (!userId || !orgId) throw new UnauthorizedError('missing x-dfap-user / x-dfap-org headers');
    const role = await this.resolveRole(orgId, userId);
    if (!role || !ROLES.has(role)) throw new UnauthorizedError('identity has no membership in the requested organization');
    return { userId, orgId, role };
  }
}
