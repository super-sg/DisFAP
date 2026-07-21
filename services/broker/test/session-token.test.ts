import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryNonceStore } from '../src/nonce-store.js';
import {
  mintConnectToken,
  verifyConnectToken,
  type Keyring,
  TOKEN_PREFIX,
} from '../src/session-token.js';

const NOW = 1_753_142_400;

function ring(): Keyring {
  return {
    keys: new Map([
      ['k_old', randomBytes(32)],
      ['k_cur', randomBytes(32)],
    ]),
    signingKid: 'k_cur',
  };
}

function mint(keyring = ring(), overrides: Parameters<typeof mintConnectToken>[0] | object = {}) {
  return mintConnectToken(
    { sid: 'ses_1', sub: 'usr_1', org: 'org_1', now: NOW, ...overrides },
    keyring,
  );
}

describe('DFAP1 connect tokens', () => {
  it('round-trips a valid token', async () => {
    const kr = ring();
    const res = await verifyConnectToken(mint(kr), kr, new InMemoryNonceStore(), { now: NOW + 10 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.payload).toMatchObject({ sid: 'ses_1', sub: 'usr_1', org: 'org_1', aud: 'broker', scp: ['connect'] });
      expect(res.payload.exp - res.payload.iat).toBe(60);
    }
  });

  it('carries no connection parameters — the payload names a session, nothing else', () => {
    const token = mint();
    const payload = JSON.parse(Buffer.from(token.split('.')[2]!, 'base64url').toString());
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'jti', 'org', 'scp', 'sid', 'sub']);
    const flat = JSON.stringify(payload).toLowerCase();
    for (const banned of ['host', 'password', 'username', 'port', 'rdp', 'ip']) {
      expect(flat).not.toContain(banned);
    }
  });

  it('rejects a tampered payload (sid swap)', async () => {
    const kr = ring();
    const [pfx, h, p, s] = mint(kr).split('.') as [string, string, string, string];
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    payload.sid = 'ses_victim';
    const forged = `${pfx}.${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    const res = await verifyConnectToken(forged, kr, new InMemoryNonceStore(), { now: NOW });
    expect(res).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('rejects algorithm confusion — header.alg is pinned, not dispatched', async () => {
    const kr = ring();
    const [pfx, h, p] = mint(kr).split('.') as [string, string, string];
    const hdr = JSON.parse(Buffer.from(h, 'base64url').toString());
    hdr.alg = 'none';
    const h2 = Buffer.from(JSON.stringify(hdr)).toString('base64url');
    const res = await verifyConnectToken(`${pfx}.${h2}.${p}.`, kr, new InMemoryNonceStore(), { now: NOW });
    expect(res).toMatchObject({ ok: false, reason: 'alg_not_pinned' });
  });

  it('rejects an expired token', async () => {
    const kr = ring();
    const res = await verifyConnectToken(mint(kr), kr, new InMemoryNonceStore(), { now: NOW + 61 });
    expect(res).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('rejects a token from the future beyond clock skew', async () => {
    const kr = ring();
    const res = await verifyConnectToken(mint(kr), kr, new InMemoryNonceStore(), { now: NOW - 30 });
    expect(res).toMatchObject({ ok: false, reason: 'not_yet_valid' });
  });

  it('accepts small clock skew', async () => {
    const kr = ring();
    const res = await verifyConnectToken(mint(kr), kr, new InMemoryNonceStore(), { now: NOW - 3 });
    expect(res.ok).toBe(true);
  });

  it('flags replay as a terminate-session event', async () => {
    const kr = ring();
    const nonces = new InMemoryNonceStore();
    const token = mint(kr);
    expect((await verifyConnectToken(token, kr, nonces, { now: NOW })).ok).toBe(true);
    const replay = await verifyConnectToken(token, kr, nonces, { now: NOW + 1 });
    expect(replay).toMatchObject({ ok: false, reason: 'replayed', terminateSession: true });
  });

  it('verifies with an older ring key (rotation) but always mints with the signing key', async () => {
    const kr = ring();
    const oldRing: Keyring = { keys: kr.keys, signingKid: 'k_old' };
    const tokenFromOldKey = mint(oldRing);
    const res = await verifyConnectToken(tokenFromOldKey, kr, new InMemoryNonceStore(), { now: NOW });
    expect(res.ok).toBe(true);
    expect(JSON.parse(Buffer.from(mint(kr).split('.')[1]!, 'base64url').toString()).kid).toBe('k_cur');
  });

  it('rejects an unknown kid', async () => {
    const kr = ring();
    const other: Keyring = { keys: new Map([['k_mystery', randomBytes(32)]]), signingKid: 'k_mystery' };
    const res = await verifyConnectToken(mint(other), kr, new InMemoryNonceStore(), { now: NOW });
    expect(res).toMatchObject({ ok: false, reason: 'unknown_kid' });
  });

  it('rejects a signature made with a different key under a valid kid', async () => {
    const kr = ring();
    const evil: Keyring = { keys: new Map([['k_cur', randomBytes(32)]]), signingKid: 'k_cur' };
    const res = await verifyConnectToken(mint(evil), kr, new InMemoryNonceStore(), { now: NOW });
    expect(res).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it.each([
    ['garbage', 'not-a-token'],
    ['wrong prefix', 'JWT.a.b.c'],
    ['too few parts', `${TOKEN_PREFIX}.a.b`],
    ['unparseable header', `${TOKEN_PREFIX}.!!!.${Buffer.from('{}').toString('base64url')}.sig`],
  ])('rejects malformed input: %s', async (_label, token) => {
    const res = await verifyConnectToken(token, ring(), new InMemoryNonceStore(), { now: NOW });
    expect(res.ok).toBe(false);
  });

  it('rejects the wrong token type (reconnect token on the connect path)', async () => {
    const kr = ring();
    const token = mintConnectToken({ sid: 's', sub: 'u', org: 'o', typ: 'dfap-reconn', now: NOW }, kr);
    const res = await verifyConnectToken(token, kr, new InMemoryNonceStore(), { now: NOW });
    expect(res).toMatchObject({ ok: false, reason: 'wrong_type' });
  });

  it('generates unique jtis', () => {
    const kr = ring();
    const jtis = new Set(
      Array.from({ length: 100 }, () =>
        JSON.parse(Buffer.from(mint(kr).split('.')[2]!, 'base64url').toString()).jti,
      ),
    );
    expect(jtis.size).toBe(100);
  });
});
