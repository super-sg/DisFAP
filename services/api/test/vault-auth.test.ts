import { describe, expect, it, vi } from 'vitest';

import { AppRoleTokenSource, StaticTokenSource } from '../src/vault/vault-auth.js';
import { VaultAuthError } from '../src/vault/errors.js';

interface LoginCall {
  url: string;
  body: { role_id?: string; secret_id?: string };
  namespace?: string;
}

/** A fake Vault AppRole login endpoint. Counts calls; never opens a socket. */
function fakeLogin(opts: {
  token: string | ((n: number) => string);
  leaseDurationS?: number;
  status?: number;
}): { fetchImpl: typeof fetch; calls: LoginCall[] } {
  const calls: LoginCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as LoginCall['body'],
      ...(((init?.headers as Record<string, string>)?.['X-Vault-Namespace'])
        ? { namespace: (init?.headers as Record<string, string>)['X-Vault-Namespace'] }
        : {}),
    });
    const status = opts.status ?? 200;
    if (status !== 200) {
      return new Response(JSON.stringify({ errors: ['denied'] }), { status });
    }
    const token = typeof opts.token === 'function' ? opts.token(calls.length) : opts.token;
    return new Response(
      JSON.stringify({ auth: { client_token: token, lease_duration: opts.leaseDurationS ?? 1200 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('StaticTokenSource', () => {
  it('returns the configured token and refuses an empty one', async () => {
    const src = new StaticTokenSource('s.static');
    await expect(src.get()).resolves.toBe('s.static');
    expect(() => new StaticTokenSource('')).toThrow(VaultAuthError);
  });

  it('cannot refresh — invalidate is a no-op and the same token comes back', async () => {
    const src = new StaticTokenSource('s.static');
    src.invalidate();
    await expect(src.get()).resolves.toBe('s.static');
  });
});

describe('AppRoleTokenSource', () => {
  it('logs in with role_id/secret_id and caches the token for the lease', async () => {
    const { fetchImpl, calls } = fakeLogin({ token: 's.approle.1', leaseDurationS: 1200 });
    let now = 1_000_000;
    const src = new AppRoleTokenSource({
      addr: 'https://vault.test:8200/',
      roleId: 'role-1',
      secretId: 'secret-1',
      fetchImpl,
      now: () => now,
    });

    await expect(src.get()).resolves.toBe('s.approle.1');
    await expect(src.get()).resolves.toBe('s.approle.1');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://vault.test:8200/v1/auth/approle/login');
    expect(calls[0]?.body).toEqual({ role_id: 'role-1', secret_id: 'secret-1' });

    // A long lease is still capped at MAX_CACHE_MS (5 min) so a revoked or
    // rotated token cannot be reused for the whole 20-minute lease.
    now += 5 * 60_000 - 1;
    await expect(src.get()).resolves.toBe('s.approle.1');
    expect(calls).toHaveLength(1);
    now += 1;
    await expect(src.get()).resolves.toBe('s.approle.1');
    expect(calls).toHaveLength(2);
  });

  it('re-authenticates before the lease expires, and on invalidate', async () => {
    const { fetchImpl, calls } = fakeLogin({
      token: (n) => `s.approle.${n}`,
      leaseDurationS: 300,
    });
    let now = 0;
    const src = new AppRoleTokenSource({
      addr: 'https://vault.test:8200',
      roleId: 'r',
      secretId: 's',
      fetchImpl,
      now: () => now,
    });

    await expect(src.get()).resolves.toBe('s.approle.1');
    // 300s lease => refresh 60s early, i.e. at 240s.
    now = 240_000;
    await expect(src.get()).resolves.toBe('s.approle.2');
    expect(calls).toHaveLength(2);

    src.invalidate();
    await expect(src.get()).resolves.toBe('s.approle.3');
    expect(calls).toHaveLength(3);
    expect(src.loginCount).toBe(3);
  });

  it('shares one login across concurrent callers (no stampede)', async () => {
    const { fetchImpl, calls } = fakeLogin({ token: 's.one', leaseDurationS: 600 });
    const src = new AppRoleTokenSource({
      addr: 'https://vault.test:8200',
      roleId: 'r',
      secretId: 's',
      fetchImpl,
    });
    const results = await Promise.all([src.get(), src.get(), src.get(), src.get()]);
    expect(results).toEqual(['s.one', 's.one', 's.one', 's.one']);
    expect(calls).toHaveLength(1);
  });

  it('fails closed on a rejected login, exposing only the status', async () => {
    const { fetchImpl } = fakeLogin({ token: 'unused', status: 403 });
    const src = new AppRoleTokenSource({
      addr: 'https://vault.test:8200',
      roleId: 'role-secret-id',
      secretId: 'secret-secret-id',
      fetchImpl,
    });
    const err = await src.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultAuthError);
    const message = (err as Error).message;
    expect(message).toContain('403');
    expect(message).not.toContain('role-secret-id');
    expect(message).not.toContain('secret-secret-id');
  });

  it('fails closed when login returns no client token', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ auth: {} }), { status: 200 })) as unknown as typeof fetch;
    const src = new AppRoleTokenSource({ addr: 'https://vault.test:8200', roleId: 'r', secretId: 's', fetchImpl });
    await expect(src.get()).rejects.toBeInstanceOf(VaultAuthError);
  });

  it('fails closed when the network call throws (never a fallback token)', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:8200');
    }) as unknown as typeof fetch;
    const src = new AppRoleTokenSource({ addr: 'https://vault.test:8200', roleId: 'r', secretId: 's', fetchImpl });
    const err = await src.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultAuthError);
    expect((err as Error).message).toBe('vault approle login failed');
  });

  it('sends the configured namespace header', async () => {
    const { fetchImpl, calls } = fakeLogin({ token: 's.ns' });
    const src = new AppRoleTokenSource({
      addr: 'https://vault.test:8200',
      roleId: 'r',
      secretId: 's',
      namespace: 'team-a',
      fetchImpl,
    });
    await src.get();
    expect(calls[0]?.namespace).toBe('team-a');
  });

  it('requires both a role_id and a secret_id at construction', () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(() => new AppRoleTokenSource({ addr: 'https://v', roleId: '', secretId: 's', fetchImpl })).toThrow(
      VaultAuthError,
    );
    expect(() => new AppRoleTokenSource({ addr: 'https://v', roleId: 'r', secretId: '', fetchImpl })).toThrow(
      VaultAuthError,
    );
  });
});
