/**
 * Production authenticator: a verified OIDC/JWT access token → a DisFAP
 * principal, via server-side identity and membership records.
 *
 * The external `sub` is NEVER equated with an internal user id: it is looked up
 * through `IdentityRepo` keyed on (issuer, subject). Organization membership and
 * role come from `org_members` (via `MembershipRepo`), never from a claim or a
 * header. `x-dfap-user` / `x-dfap-org` / `x-dfap-role` are ignored entirely.
 *
 * Every rejection is fail-closed: an unmapped identity or a caller with no valid
 * organization membership is refused, not granted a default.
 */

import {
  ForbiddenError,
  UnauthorizedError,
  type AuthRequestView,
  type Authenticator,
  type Principal,
} from './authenticator.js';
import type { AccessTokenVerifier } from './jwks.js';
import type { IdentityRepo, MembershipRepo } from '../ports.js';

export interface OidcAuthenticatorDeps {
  verifier: AccessTokenVerifier;
  identities: IdentityRepo;
  memberships: MembershipRepo;
  /**
   * Optional claim naming the organization. It only SELECTS among the caller's
   * real server-side memberships; it never grants one.
   */
  orgClaim?: string;
}

function extractBearer(req: AuthRequestView): string {
  const raw = req.headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) throw new UnauthorizedError('missing bearer token');
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  const token = match?.[1];
  if (!token) throw new UnauthorizedError('malformed authorization header');
  return token;
}

export class OidcAuthenticator implements Authenticator {
  constructor(private readonly deps: OidcAuthenticatorDeps) {}

  async authenticate(req: AuthRequestView): Promise<Principal> {
    const token = extractBearer(req);
    const verified = await this.deps.verifier.verify(token);

    // (issuer, subject) → internal user. Unmapped ⇒ reject (no JIT provisioning).
    const userId = await this.deps.identities.resolve(verified.issuer, verified.subject);
    if (!userId) throw new ForbiddenError('no DisFAP user is mapped to this identity');

    // The org claim, when configured and present, must be a string; it is only a
    // selector and is validated against real memberships below.
    let orgHint: string | undefined;
    if (this.deps.orgClaim !== undefined) {
      const claim = verified.claims[this.deps.orgClaim];
      if (claim !== undefined && typeof claim !== 'string') {
        throw new ForbiddenError('organization claim is malformed');
      }
      orgHint = claim;
    }

    const membership = await this.deps.memberships.resolveMembership(userId, orgHint);
    if (!membership) throw new ForbiddenError('identity holds no organization membership');

    return { userId, orgId: membership.orgId, role: membership.role };
  }
}
