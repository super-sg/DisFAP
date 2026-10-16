/**
 * OidcAuthenticator — external-identity mapping, membership resolution, and the
 * guarantee that claims/headers never confer privilege. Uses fakes for the
 * verifier and the two server-side repos so the logic is isolated from crypto.
 */

import { describe, expect, it } from 'vitest';

import { ForbiddenError, UnauthorizedError } from '../src/auth/authenticator.js';
import { OidcAuthenticator } from '../src/auth/oidc.js';
import type { AccessTokenVerifier, VerifiedAccessToken } from '../src/auth/jwks.js';
import type { IdentityRepo, MemberResolution, MembershipRepo } from '../src/ports.js';

function req(headers: Record<string, string>) {
  return { headers };
}

function verifierOf(token: VerifiedAccessToken | Error): AccessTokenVerifier {
  return {
    verify: async () => {
      if (token instanceof Error) throw token;
      return token;
    },
  };
}

function identitiesOf(mapping: Record<string, string>): IdentityRepo {
  return {
    resolve: async (issuer, subject) => mapping[`${issuer}|${subject}`] ?? null,
  };
}

/** In-memory membership store keyed by `${orgId}|${userId}` → role. */
function membershipsOf(entries: Record<string, MemberResolution>[], roleOfFn?: MembershipRepo['roleOf']): MembershipRepo {
  const rows = entries.map((e) => {
    const [key, value] = Object.entries(e)[0]!;
    const [orgId, userId] = key.split('|') as [string, string];
    return { orgId, userId, role: value.role };
  });
  return {
    roleOf:
      roleOfFn ??
      (async (orgId, userId) => rows.find((r) => r.orgId === orgId && r.userId === userId)?.role ?? null),
    resolveMembership: async (userId, orgHint) => {
      if (orgHint !== undefined) {
        const row = rows.find((r) => r.userId === userId && r.orgId === orgHint);
        return row ? { orgId: row.orgId, role: row.role } : null;
      }
      const mine = rows.filter((r) => r.userId === userId);
      return mine.length === 1 ? { orgId: mine[0]!.orgId, role: mine[0]!.role } : null;
    },
  };
}

const TOKEN: VerifiedAccessToken = { issuer: 'https://issuer.test/', subject: 'ext-sub-1', claims: {} };

function build(opts: {
  verified?: VerifiedAccessToken | Error;
  mapping?: Record<string, string>;
  memberships: MembershipRepo;
  orgClaim?: string;
}) {
  return new OidcAuthenticator({
    verifier: verifierOf(opts.verified ?? TOKEN),
    identities: identitiesOf(opts.mapping ?? { 'https://issuer.test/|ext-sub-1': 'usr_internal' }),
    memberships: opts.memberships,
    ...(opts.orgClaim ? { orgClaim: opts.orgClaim } : {}),
  });
}

const BEARER = req({ authorization: 'Bearer header.payload.signature' });

describe('OidcAuthenticator — bearer extraction', () => {
  it('rejects a request with no Authorization header', async () => {
    const auth = build({ memberships: membershipsOf([]) });
    await expect(auth.authenticate(req({}))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a non-Bearer scheme', async () => {
    const auth = build({ memberships: membershipsOf([]) });
    await expect(auth.authenticate(req({ authorization: 'Basic dXNlcjpwYXNz' }))).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('maps a verifier rejection to 401', async () => {
    const auth = build({ verified: new UnauthorizedError('bad token'), memberships: membershipsOf([]) });
    await expect(auth.authenticate(BEARER)).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe('OidcAuthenticator — identity mapping', () => {
  it('resolves a mapped (issuer, subject) to the internal principal', async () => {
    const memberships = membershipsOf([{ 'org_1|usr_internal': { orgId: 'org_1', role: 'member' } }]);
    const auth = build({ memberships });
    await expect(auth.authenticate(BEARER)).resolves.toEqual({
      userId: 'usr_internal',
      orgId: 'org_1',
      role: 'member',
    });
  });

  it('rejects an unmapped external identity (no JIT provisioning)', async () => {
    const memberships = membershipsOf([{ 'org_1|usr_internal': { orgId: 'org_1', role: 'member' } }]);
    const auth = new OidcAuthenticator({
      verifier: verifierOf({ issuer: 'https://issuer.test/', subject: 'ghost', claims: {} }),
      identities: identitiesOf({}), // nothing mapped
      memberships,
    });
    await expect(auth.authenticate(BEARER)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects a mapped user with no organization membership', async () => {
    const auth = build({ memberships: membershipsOf([]) });
    await expect(auth.authenticate(BEARER)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects an ambiguous (multi-org) user when no org claim is configured', async () => {
    const memberships = membershipsOf([
      { 'org_a|usr_internal': { orgId: 'org_a', role: 'member' } },
      { 'org_b|usr_internal': { orgId: 'org_b', role: 'member' } },
    ]);
    const auth = build({ memberships });
    await expect(auth.authenticate(BEARER)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('OidcAuthenticator — org claim is a selector only', () => {
  const memberships = () =>
    membershipsOf([
      { 'org_a|usr_internal': { orgId: 'org_a', role: 'admin' } },
      { 'org_b|usr_internal': { orgId: 'org_b', role: 'member' } },
    ]);

  it('selects among real memberships using the org claim', async () => {
    const auth = build({
      verified: { issuer: 'https://issuer.test/', subject: 'ext-sub-1', claims: { org: 'org_b' } },
      memberships: memberships(),
      orgClaim: 'org',
    });
    await expect(auth.authenticate(BEARER)).resolves.toMatchObject({ orgId: 'org_b', role: 'member' });
  });

  it('rejects an org claim naming an org the user is not a member of', async () => {
    const auth = build({
      verified: { issuer: 'https://issuer.test/', subject: 'ext-sub-1', claims: { org: 'org_evil' } },
      memberships: memberships(),
      orgClaim: 'org',
    });
    await expect(auth.authenticate(BEARER)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects a malformed (non-string) org claim', async () => {
    const auth = build({
      verified: { issuer: 'https://issuer.test/', subject: 'ext-sub-1', claims: { org: 42 } },
      memberships: memberships(),
      orgClaim: 'org',
    });
    await expect(auth.authenticate(BEARER)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('OidcAuthenticator — no privilege from claims or headers', () => {
  it('derives the role from server-side records, ignoring role claims', async () => {
    const memberships = membershipsOf([{ 'org_1|usr_internal': { orgId: 'org_1', role: 'member' } }]);
    const auth = build({
      verified: {
        issuer: 'https://issuer.test/',
        subject: 'ext-sub-1',
        claims: { role: 'admin', 'x-dfap-role': 'owner', 'https://disfap.test/roles': ['admin'] },
      },
      memberships,
    });
    await expect(auth.authenticate(BEARER)).resolves.toMatchObject({ role: 'member' });
  });

  it('ignores x-dfap-* headers entirely (identity comes from the token)', async () => {
    const memberships = membershipsOf([{ 'org_1|usr_internal': { orgId: 'org_1', role: 'member' } }]);
    const auth = build({ memberships });
    const principal = await auth.authenticate(
      req({
        authorization: 'Bearer header.payload.signature',
        'x-dfap-user': 'usr_attacker',
        'x-dfap-org': 'org_1',
        'x-dfap-role': 'admin',
      }),
    );
    expect(principal).toEqual({ userId: 'usr_internal', orgId: 'org_1', role: 'member' });
  });
});
