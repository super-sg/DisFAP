import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  HttpVaultClient,
  VaultRequestError,
  WrapTokenConsumedError,
  type HttpVaultOptions,
} from '../src/vault/vault-client.js';
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
