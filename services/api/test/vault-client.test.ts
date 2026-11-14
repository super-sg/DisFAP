import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  HttpVaultClient,
  VaultAuthError,
  VaultRequestError,
  WrapTokenConsumedError,
  type HttpVaultOptions,
} from '../src/vault/vault-client.js';
import { AppRoleTokenSource, StaticTokenSource } from '../src/vault/vault-auth.js';
import { MockVaultServer } from './support/mock-vault.js';

let vault: MockVaultServer;
let addr: string;

beforeAll(async () => {
  vault = new MockVaultServer();
  addr = await vault.start();
});
afterAll(async () => {
  await vault.close();
});

function client(over: Partial<HttpVaultOptions> = {}): HttpVaultClient {
  return new HttpVaultClient({ addr, token: 'root-token', ...over });
}

describe('HttpVaultClient — wrap/unwrap over HTTP', () => {
  it('writes with a wrap TTL and returns a wrap token, not the data', async () => {
    const c = client();
    const wrapped = await c.writeWrappedSecret('sessions/s1/rdp', { username: 'u', password: 'p' }, 60);
    expect(wrapped.wrapToken).toMatch(/^s\.mock\./);
    // The secret value never came back in the write response.
    expect(JSON.stringify(wrapped)).not.toContain('password');
  });

  it('unwraps exactly once; a second unwrap is refused', async () => {
    const c = client();
    const { wrapToken } = await c.writeWrappedSecret('sessions/s2/rdp', { username: 'u', password: 'p' }, 60);

    const secret = await c.unwrap(wrapToken);
    expect(secret.path).toBe('sessions/s2/rdp');
    expect(secret.data).toEqual({ username: 'u', password: 'p' });

    await expect(c.unwrap(wrapToken)).rejects.toBeInstanceOf(WrapTokenConsumedError);
  });

  it('refuses an expired wrap token', async () => {
    const c = client();
    const { wrapToken } = await c.writeWrappedSecret('sessions/s3/rdp', { username: 'u' }, 60);
    vault.expireAll();
    await expect(c.unwrap(wrapToken)).rejects.toBeInstanceOf(WrapTokenConsumedError);
  });

  it('sends the API token for writes and the wrap token for unwrap', async () => {
    const c = client();
    const { wrapToken } = await c.writeWrappedSecret('sessions/s4/rdp', { username: 'u' }, 60);
    await c.unwrap(wrapToken);
    const write = vault.seen.findLast((r) => r.method === 'POST' && r.path.includes('/data/'));
    const unwrap = vault.seen.findLast((r) => r.path === '/v1/sys/wrapping/unwrap');
    expect(write?.token).toBe('root-token');
    expect(write?.wrapTtl).toBe('60');
    expect(unwrap?.token).toBe(wrapToken);
  });

  it('sends the configured Vault namespace', async () => {
    const c = client({ namespace: 'team-a' });
    await c.writeWrappedSecret('sessions/s5/rdp', { username: 'u' }, 60);
    expect(vault.seen.some((r) => r.namespace === 'team-a')).toBe(true);
  });

  it('deletes the secret path on revoke (idempotent)', async () => {
    const c = client();
    await c.writeWrappedSecret('sessions/s6/rdp', { username: 'u' }, 60);
    expect(vault.has('sessions/s6/rdp')).toBe(true);
    await c.revoke('sessions/s6/rdp');
    expect(vault.has('sessions/s6/rdp')).toBe(false);
    // Revoking an already-gone path is a no-op, not an error.
    await expect(c.revoke('sessions/s6/rdp')).resolves.toBeUndefined();
  });
});

describe('HttpVaultClient — server-side read (guest provisioning, M8)', () => {
  it('reads a written secret with the API token and returns its data', async () => {
    const c = client();
    await c.writeWrappedSecret('sessions/g1/rdp', { username: 'u', password: 'p' }, 60);
    await expect(c.read('sessions/g1/rdp')).resolves.toEqual({ username: 'u', password: 'p' });
    const get = vault.seen.findLast((r) => r.method === 'GET' && r.path.includes('/data/'));
    expect(get?.token).toBe('root-token');
  });

  it('returns null for an absent path rather than throwing', async () => {
    await expect(client().read('sessions/does-not-exist/rdp')).resolves.toBeNull();
  });

  it('does NOT consume the broker wrap token — a read and an unwrap can coexist', async () => {
    const c = client();
    const { wrapToken } = await c.writeWrappedSecret('sessions/g2/rdp', { username: 'u', password: 'p' }, 60);
    // Guest provisioning reads the path server-side...
    await expect(c.read('sessions/g2/rdp')).resolves.toEqual({ username: 'u', password: 'p' });
    // ...and the broker can still unwrap the single-use wrap token afterwards.
    const unwrapped = await c.unwrap(wrapToken);
    expect(unwrapped.data).toEqual({ username: 'u', password: 'p' });
  });
});

describe('HttpVaultClient — re-issue a handle for an existing secret', () => {
  it('wraps a READ: Vault returns only wrap_info, no plaintext', async () => {
    const c = client();
    await c.writeWrappedSecret('sessions/r1/rdp', { username: 'u', password: 'p' }, 900);

    const wrapped = await c.wrapExistingSecret('sessions/r1/rdp', 120);
    expect(wrapped).not.toBeNull();
    expect(wrapped!.wrapToken).toMatch(/^s\.mock\./);
    // Nothing credential-shaped came back to the control plane.
    expect(JSON.stringify(wrapped)).not.toContain('password');

    const get = vault.seen.findLast((r) => r.method === 'GET' && r.path.includes('/data/sessions/r1/rdp'));
    expect(get?.token).toBe('root-token');
    expect(get?.wrapTtl).toBe('120');

    // The handle is single-use and resolves to the ORIGINAL stored secret.
    const secret = await c.unwrap(wrapped!.wrapToken);
    expect(secret).toEqual({ path: 'sessions/r1/rdp', data: { username: 'u', password: 'p' } });
    await expect(c.unwrap(wrapped!.wrapToken)).rejects.toBeInstanceOf(WrapTokenConsumedError);
  });

  it('can mint more than one independent handle (reconnect / page refresh)', async () => {
    const c = client();
    await c.writeWrappedSecret('sessions/r2/rdp', { username: 'u' }, 900);
    const a = await c.wrapExistingSecret('sessions/r2/rdp', 120);
    const b = await c.wrapExistingSecret('sessions/r2/rdp', 120);
    expect(a!.wrapToken).not.toBe(b!.wrapToken);
    await expect(c.unwrap(a!.wrapToken)).resolves.toMatchObject({ data: { username: 'u' } });
    await expect(c.unwrap(b!.wrapToken)).resolves.toMatchObject({ data: { username: 'u' } });
  });

  it('returns null when the persisted secret no longer exists (fail closed)', async () => {
    await expect(client().wrapExistingSecret('sessions/gone/rdp', 60)).resolves.toBeNull();
    const c = client();
    await c.writeWrappedSecret('sessions/r3/rdp', { username: 'u' }, 60);
    await c.revoke('sessions/r3/rdp');
    await expect(c.wrapExistingSecret('sessions/r3/rdp', 60)).resolves.toBeNull();
  });

  it('refuses a non-positive wrap TTL before contacting Vault', async () => {
    const before = vault.seen.length;
    await expect(client().wrapExistingSecret('sessions/r4/rdp', 0)).rejects.toThrow(/positive number/);
    expect(vault.seen.length).toBe(before);
  });
});

describe('HttpVaultClient — auth, errors, timeouts (no secret/token leakage)', () => {
  it('throws a status-only error on a rejected write, leaking neither token nor secret', async () => {
    const c = client({ token: 'wrong-token' });
    const err = await c
      .writeWrappedSecret('sessions/s7/rdp', { username: 'u', password: 'sup3r-secret' }, 60)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultRequestError);
    expect((err as VaultRequestError).status).toBe(403);
    const msg = (err as Error).message;
    expect(msg).not.toContain('wrong-token');
    expect(msg).not.toContain('sup3r-secret');
  });

  it('surfaces a server error as a VaultRequestError with the status', async () => {
    vault.failStatus = 500;
    try {
      await expect(client().writeWrappedSecret('sessions/s8/rdp', { username: 'u' }, 60)).rejects.toMatchObject({
        name: 'VaultRequestError',
        status: 500,
      });
    } finally {
      vault.failStatus = null;
    }
  });

  it('times out a slow request', async () => {
    vault.delayMs = 300;
    try {
      await expect(client({ requestTimeoutMs: 30 }).writeWrappedSecret('sessions/s9/rdp', { username: 'u' }, 60)).rejects.toThrow(
        /timed out/,
      );
    } finally {
      vault.delayMs = 0;
    }
  });

  it('requires an address and a token at construction', () => {
    expect(() => new HttpVaultClient({ addr: '', token: 't' })).toThrow(/addr is required/);
    expect(() => new HttpVaultClient({ addr: 'http://x', token: '' })).toThrow(/token is required/);
  });

  it('rejects a non-positive wrap TTL rather than asking Vault for one', async () => {
    await expect(client().writeWrappedSecret('sessions/s10/rdp', { username: 'u' }, 0)).rejects.toThrow(
      /positive number/,
    );
  });
});

describe('HttpVaultClient — secret paths cannot escape the sessions prefix', () => {
  const UNSAFE = ['../sys/policies', 'sessions/../../sys/policies', '/sessions/x', 'sessions/x?y', 'sessions//x', 'sessions/x y', 'sessions/..', ''];

  it.each(UNSAFE)('refuses %j before sending any request', async (path) => {
    const before = vault.seen.length;
    const c = client();
    await expect(c.writeWrappedSecret(path, { username: 'u' }, 60)).rejects.toBeInstanceOf(VaultRequestError);
    await expect(c.read(path)).rejects.toBeInstanceOf(VaultRequestError);
    // A DELETE of `metadata/<path>` is the destructive one: never reached.
    await expect(c.revoke(path)).rejects.toBeInstanceOf(VaultRequestError);
    expect(vault.seen.length).toBe(before);
  });

  it('accepts the ids the control plane actually generates', async () => {
    const c = client();
    const path = 'sessions/ses_01J8Z9-A.bc/rdp';
    await expect(c.writeWrappedSecret(path, { username: 'u' }, 60)).resolves.toHaveProperty('wrapToken');
    await expect(c.revoke(path)).resolves.toBeUndefined();
  });
});

describe('HttpVaultClient — AppRole identity', () => {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('re-authenticates once on a 403 and retries with the fresh token', async () => {
    let logins = 0;
    const used: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/v1/auth/approle/login')) {
        logins += 1;
        return json({ auth: { client_token: `tok-${logins}`, lease_duration: 600 } });
      }
      const tok = (init?.headers as Record<string, string>)['X-Vault-Token'] ?? '';
      used.push(tok);
      // The first short-lived token was revoked between login and request.
      if (tok === 'tok-1') return json({ errors: ['permission denied'] }, 403);
      return json({ wrap_info: { token: 's.wrapped', ttl: 60 } });
    }) as unknown as typeof fetch;

    const src = new AppRoleTokenSource({ addr: 'https://vault.test', roleId: 'r', secretId: 's', fetchImpl });
    const c = new HttpVaultClient({ addr: 'https://vault.test', tokenSource: src, fetchImpl });

    await expect(c.writeWrappedSecret('sessions/s11/rdp', { username: 'u' }, 60)).resolves.toMatchObject({
      wrapToken: 's.wrapped',
    });
    expect(used).toEqual(['tok-1', 'tok-2']);
    expect(src.loginCount).toBe(2);
  });

  it('does not retry a policy denial for a static token', async () => {
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      return json({ errors: ['permission denied'] }, 403);
    }) as unknown as typeof fetch;
    const c = new HttpVaultClient({ addr: 'https://vault.test', token: 'static', fetchImpl });
    await expect(c.writeWrappedSecret('sessions/s12/rdp', { username: 'u' }, 60)).rejects.toBeInstanceOf(
      VaultRequestError,
    );
    expect(requests).toBe(1);
  });

  it('fails closed (no request at all) when AppRole login fails', async () => {
    let dataRequests = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).endsWith('/login')) return json({ errors: ['bad role'] }, 403);
      dataRequests += 1;
      return json({});
    }) as unknown as typeof fetch;
    const src = new AppRoleTokenSource({ addr: 'https://vault.test', roleId: 'r', secretId: 's', fetchImpl });
    const c = new HttpVaultClient({ addr: 'https://vault.test', tokenSource: src, fetchImpl });
    await expect(c.read('sessions/s13/rdp')).rejects.toBeInstanceOf(VaultAuthError);
    expect(dataRequests).toBe(0);
  });

  it('refuses to configure a static token and a token source at once', () => {
    const src = new StaticTokenSource('t');
    expect(() => new HttpVaultClient({ addr: 'http://x', token: 't', tokenSource: src })).toThrow(/not both/);
  });
});
