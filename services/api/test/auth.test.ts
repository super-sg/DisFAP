import { describe, expect, it, vi } from 'vitest';

import {
  DevHeaderAuthenticator,
  FailClosedAuthenticator,
  UnauthorizedError,
  type Authenticator,
  type AuthRequestView,
  type PrincipalRole,
} from '../src/auth/authenticator.js';

function req(headers: Record<string, string>): AuthRequestView {
  return { headers };
}

describe('FailClosedAuthenticator', () => {
  it('rejects every request with 401', async () => {
    const auth: Authenticator = new FailClosedAuthenticator();
    await expect(auth.authenticate(req({ 'x-dfap-user': 'usr_1', 'x-dfap-org': 'org_1', 'x-dfap-role': 'admin' }))).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });
});

describe('DevHeaderAuthenticator', () => {
  it('resolves identity from headers and the role from the resolver', async () => {
    const resolveRole = vi.fn(async () => 'admin' as PrincipalRole);
    const auth = new DevHeaderAuthenticator(resolveRole);

    const principal = await auth.authenticate(req({ 'x-dfap-user': 'usr_1', 'x-dfap-org': 'org_1' }));

    expect(principal).toEqual({ userId: 'usr_1', orgId: 'org_1', role: 'admin' });
    expect(resolveRole).toHaveBeenCalledWith('org_1', 'usr_1');
  });

  it('IGNORES a forged x-dfap-role header and uses the server-side role', async () => {
    const resolveRole = vi.fn(async () => 'member' as PrincipalRole);
    const auth = new DevHeaderAuthenticator(resolveRole);

    const principal = await auth.authenticate(
      req({ 'x-dfap-user': 'usr_1', 'x-dfap-org': 'org_1', 'x-dfap-role': 'owner' }),
    );

    expect(principal.role).toBe('member');
  });

  it('rejects a request missing the identity headers', async () => {
    const auth = new DevHeaderAuthenticator(async () => 'member');
    await expect(auth.authenticate(req({ 'x-dfap-org': 'org_1' }))).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(auth.authenticate(req({ 'x-dfap-user': 'usr_1' }))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects an identity with no membership in the org', async () => {
    const auth = new DevHeaderAuthenticator(async () => null);
    await expect(
      auth.authenticate(req({ 'x-dfap-user': 'usr_1', 'x-dfap-org': 'org_1' })),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
