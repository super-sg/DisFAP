/**
 * Credential re-issuance (Objective A).
 *
 * The load-bearing properties:
 *  - every authorized read yields a NEW capability + a NEW Vault wrap token;
 *  - the wrap is bound to that capability's jti, so an older capability can
 *    never consume a newer handle;
 *  - Vault stays the source of truth: a lost in-process cache (API restart) is
 *    recoverable, a revoked secret is not;
 *  - the browser-facing object never contains credential material.
 */

import { randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import { verifyConnectToken } from '@disfap/broker/src/session-token.js';
import { InMemoryNonceStore } from '@disfap/broker/src/nonce-store.js';
import type { Keyring } from '@disfap/broker/src/session-token.js';

import {
  issueConnectHandle,
  isWithinReconnectGrace,
  mayIssueConnectHandle,
  type ConnectHandleDeps,
} from '../src/sessions/connect-handle.js';
import { VaultCredentialIssuer } from '../src/credentials/credential-issuer.js';
import { FakeVaultClient } from '../src/vault/vault-client.js';
import { InMemoryWrapTokenCache } from '../src/vault/wrap-token-cache.js';
import { VaultCredentialProvider } from '../src/integration/vault-credential-provider.js';
import { PrismaSessionResolver } from '../src/integration/prisma-session-resolver.js';
import { publicSession } from '../src/http/session-view.js';
import type { SessionConnectRow, SessionConnectStore } from '../src/integration/prisma-session-resolver.js';
import type { SessionRecord } from '../src/ports.js';
import { buildApp } from '../src/app.js';
import type { ApiServices } from '../src/http/contracts.js';

const T0 = new Date('2026-11-12T12:00:00Z');
const SID = 'ses_1';

function keyring(): Keyring {
  return { keys: new Map([['k_cur', randomBytes(32)]]), signingKid: 'k_cur' };
}

function jtiOf(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split('.')[2]!, 'base64url').toString('utf8')) as { jti: string };
  return payload.jti;
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: SID,
    orgId: 'org_1',
    userId: 'usr_1',
    templateId: 'tpl_1',
    instanceId: 'pi_1',
    licenseId: null,
    state: 'ready',
    requestedAt: T0,
    readyAt: T0,
    firstPixelAt: null,
    connectedAt: null,
    disconnectedAt: null,
    disconnectDeadlineAt: null,
    endedAt: null,
    endReason: null,
    billableSeconds: null,
    vaultCredPath: `sessions/${SID}/rdp`,
    clientIp: null,
    clientUa: null,
    ...overrides,
  };
}

interface Rig {
  deps: ConnectHandleDeps;
  vault: FakeVaultClient;
  cache: InMemoryWrapTokenCache;
  keyring: Keyring;
  clock: { now: number };
}

/** Stage the persisted secret exactly as createSession does. */
async function rig(opts: { vault?: FakeVaultClient; clock?: { now: number } } = {}): Promise<Rig> {
  const clock = opts.clock ?? { now: T0.getTime() };
  const vault = opts.vault ?? new FakeVaultClient(() => clock.now);
  const cache = new InMemoryWrapTokenCache(() => clock.now);
  const keyringValue = keyring();
  if ((await vault.read(`sessions/${SID}/rdp`)) === null) {
    await vault.writeWrappedSecret(`sessions/${SID}/rdp`, { username: 'dfap-user', password: 'S3cret-PW' }, 900);
  }
  return {
    vault,
    cache,
    keyring: keyringValue,
    clock,
    deps: {
      credentialIssuer: new VaultCredentialIssuer(vault),
      wrapCache: cache,
      keyring: keyringValue,
      brokerUrl: 'wss://broker.test/tunnel',
      connectTokenTtlS: 60,
      credentialTtlS: 900,
      now: () => new Date(clock.now),
    },
  };
}

function connectStore(row: SessionConnectRow): SessionConnectStore {
  return {
    loadForConnect: async (sid) => (sid === row.sid ? { ...row } : null),
    markConnected: async () => true,
    markDisconnected: async () => true,
    markTerminating: async () => undefined,
  };
}

function connectRow(overrides: Partial<SessionConnectRow> = {}): SessionConnectRow {
  return {
    sid: SID,
    state: 'ready',
    org: 'org_1',
    sub: 'usr_1',
    protocol: 'rdp',
    host: '10.0.0.5',
    width: 1920,
    height: 1080,
    dpi: 96,
    recordingEnabled: false,
    disconnectDeadlineAt: null,
    ...overrides,
  };
}

describe('credential re-issuance', () => {
  it('issues a verifiable capability and a matching single-use wrap handle', async () => {
    const r = await rig();
    const handle = await issueConnectHandle(session(), r.deps);
    expect(handle).not.toBeNull();

    // Cross-service contract: minted here, verified by the broker.
    const verified = await verifyConnectToken(handle!.token, r.keyring, new InMemoryNonceStore(), {
      now: Math.floor(T0.getTime() / 1000),
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.payload.sid).toBe(SID);
    expect(verified.payload.jti).toBe(jtiOf(handle!.token));

    // The broker redeems exactly that capability's wrap token.
    const wrapToken = r.cache.take(SID, verified.payload.jti);
    expect(wrapToken).toBeTruthy();
    const cred = await new VaultCredentialProvider(r.vault).fetch(SID, wrapToken!);
    expect(cred).toEqual({ username: 'dfap-user', password: 'S3cret-PW' });
  });

  it('a second authorized read produces a distinct capability and wrap token (browser refresh)', async () => {
    const r = await rig();
    const first = await issueConnectHandle(session(), r.deps);
    const second = await issueConnectHandle(session(), r.deps);

    expect(first!.token).not.toBe(second!.token);
    expect(jtiOf(first!.token)).not.toBe(jtiOf(second!.token));

    // Consuming the first (e.g. a handshake that then failed) does not strand
    // the second: each row is independent.
    const provider = new VaultCredentialProvider(r.vault);
    await provider.fetch(SID, r.cache.take(SID, jtiOf(first!.token))!);
    const secondWrap = r.cache.take(SID, jtiOf(second!.token));
    expect(secondWrap).toBeTruthy();
    await expect(provider.fetch(SID, secondWrap!)).resolves.toMatchObject({ username: 'dfap-user' });
  });

  it('binds the wrap token to the capability jti (no cross-attempt redemption)', async () => {
    const r = await rig();
    const older = await issueConnectHandle(session(), r.deps);
    const newer = await issueConnectHandle(session(), r.deps);
    const resolver = new PrismaSessionResolver({
      store: connectStore(connectRow()),
      wrapCache: r.cache,
      graceSeconds: 30,
      now: () => new Date(r.clock.now),
    });

    // A capability that is not the one the handle was staged for cannot redeem.
    await expect(resolver.resolve(SID, 'not-a-real-jti')).resolves.toBeNull();

    // The newer capability still resolves, proving the failed attempt did not
    // consume someone else's handle.
    const resolved = await resolver.resolve(SID, jtiOf(newer!.token));
    expect(resolved).not.toBeNull();
    await expect(new VaultCredentialProvider(r.vault).fetch(SID, resolved!.credentialWrapToken)).resolves.toMatchObject({
      username: 'dfap-user',
    });

    // And the older one is still independently ownable (it was never consumed).
    expect(r.cache.take(SID, jtiOf(older!.token))).toBeTruthy();
  });

  it('an expired capability cannot redeem a wrap handle', async () => {
    const r = await rig();
    const handle = await issueConnectHandle(session(), r.deps);
    // 61 s: capability TTL (60 s) and the wrap TTL (min(900, 120) = 120 s).
    r.clock.now = T0.getTime() + 61_000;
    const verified = await verifyConnectToken(handle!.token, r.keyring, new InMemoryNonceStore(), {
      now: Math.floor(r.clock.now / 1000),
    });
    expect(verified).toEqual({ ok: false, reason: 'expired' });

    // Even a forged "still valid" claim cannot use the stored handle: the wrap
    // entry itself is short-lived and jti-scoped.
    r.clock.now = T0.getTime() + 121_000;
    expect(r.cache.take(SID, jtiOf(handle!.token))).toBeNull();
  });

  it('recovers from a failed guacd handshake by issuing a fresh handle', async () => {
    const r = await rig();
    const first = await issueConnectHandle(session(), r.deps);
    const provider = new VaultCredentialProvider(r.vault);

    // Simulate the broker consuming the credential, then guacd failing.
    await expect(provider.fetch(SID, r.cache.take(SID, jtiOf(first!.token))!)).resolves.toBeTruthy();
    await expect(provider.fetch(SID, r.cache.take(SID, jtiOf(first!.token))!)).rejects.toThrow();

    const retry = await issueConnectHandle(session(), r.deps);
    expect(retry).not.toBeNull();
    await expect(provider.fetch(SID, r.cache.take(SID, jtiOf(retry!.token))!)).resolves.toMatchObject({
      username: 'dfap-user',
    });
  });

  it('survives an API restart: a fresh process re-wraps the persisted Vault secret', async () => {
    const sharedVault = new FakeVaultClient(() => T0.getTime());
    const before = await rig({ vault: sharedVault });
    const oldHandle = await issueConnectHandle(session(), before.deps);
    expect(oldHandle).not.toBeNull();

    // "Restart": a brand-new cache, issuer and keyring, same Vault.
    const after = await rig({ vault: sharedVault });
    expect(after.cache.size()).toBe(0); // nothing survived in memory
    const resolverAfterRestart = new PrismaSessionResolver({
      store: connectStore(connectRow()),
      wrapCache: after.cache,
      graceSeconds: 30,
      now: () => T0,
    });
    // The OLD capability has no handle in the new process (fail closed)…
    await expect(resolverAfterRestart.resolve(SID, jtiOf(oldHandle!.token))).resolves.toBeNull();

    // …but an authorized read can mint a new one from the persisted secret.
    const fresh = await issueConnectHandle(session(), after.deps);
    expect(fresh).not.toBeNull();
    const resolved = await resolverAfterRestart.resolve(SID, jtiOf(fresh!.token));
    expect(resolved).not.toBeNull();
    await expect(new VaultCredentialProvider(sharedVault).fetch(SID, resolved!.credentialWrapToken)).resolves.toMatchObject({
      username: 'dfap-user',
    });
  });

  it('never issues a handle for a revoked/missing Vault secret', async () => {
    const r = await rig();
    await r.vault.revoke(`sessions/${SID}/rdp`);
    await expect(issueConnectHandle(session(), r.deps)).resolves.toBeNull();
  });
});

describe('connect-handle eligibility', () => {
  it.each(['ended', 'failed', 'terminating'] as const)('refuses a session in %s', (state) => {
    expect(mayIssueConnectHandle(session({ state }), T0)).toBe(false);
  });

  it('refuses a disconnected session whose grace deadline has passed', () => {
    const expired = session({
      state: 'disconnected',
      disconnectedAt: new Date(T0.getTime() - 60_000),
      disconnectDeadlineAt: new Date(T0.getTime() - 1_000),
    });
    expect(mayIssueConnectHandle(expired, T0)).toBe(false);
    expect(isWithinReconnectGrace(expired, T0)).toBe(false);
  });

  it('allows a disconnected session still inside the grace window', () => {
    const live = session({
      state: 'disconnected',
      disconnectedAt: T0,
      disconnectDeadlineAt: new Date(T0.getTime() + 30_000),
    });
    expect(mayIssueConnectHandle(live, T0)).toBe(true);
    expect(isWithinReconnectGrace(live, T0)).toBe(true);
  });

  it('refuses when the row has no staged Vault path', () => {
    expect(mayIssueConnectHandle(session({ vaultCredPath: null }), T0)).toBe(false);
  });
});

describe('GET /sessions/:id authorization ordering', () => {
  it('does not mint a handle for a caller who is not the renter of record', async () => {
    const renter: SessionRecord = session({ userId: 'usr_renter' });
    const issue = vi.fn(async () => null);
    const services = {
      authenticator: { authenticate: async () => ({ userId: 'usr_other', orgId: 'org_1', role: 'member' as const }) },
      createSession: async () => {
        throw new Error('unused');
      },
      endSession: async () => {
        throw new Error('unused');
      },
      getSession: async () => renter,
      issueConnectHandle: issue,
      handleWebhook: async () => ({ received: true, duplicate: false, type: 'noop' }),
    } as unknown as ApiServices;
    const app = buildApp(services);

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SID}` });
    expect(res.statusCode).toBe(403);
    // The important assertion: authorization ran BEFORE any Vault/issue work.
    expect(issue).not.toHaveBeenCalled();
  });
});

describe('browser-facing shape', () => {
  it('carries only the opaque capability — never a credential or wrap token', async () => {
    const r = await rig();
    const handle = await issueConnectHandle(session(), r.deps);
    const body = publicSession({ ...session(), connect: handle! });
    const json = JSON.stringify(body);

    expect(json).not.toMatch(/S3cret-PW|password|username|private_key/i);
    expect(json).not.toMatch(/s\.[A-Za-z0-9]/); // Vault wrap-token shape
    expect(json).toContain('DFAP1.');
  });
});
