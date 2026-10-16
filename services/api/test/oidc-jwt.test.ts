/**
 * Verification tests for the jose-backed access-token verifier.
 *
 * These exercise the REAL `jose` code path against an in-process JWKS server
 * with locally generated keys — no external IdP, no real credentials. They cover
 * signature/claim validation, key rotation, and the guarantee that a JWKS or
 * discovery failure never results in accepting an unverified token.
 */

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

import { JoseAccessTokenVerifier, type OidcVerifierConfig } from '../src/auth/jwks.js';

const ISSUER = 'https://issuer.example.test/';
const AUDIENCE = 'https://api.disfap.test';

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
type PrivateKey = KeyPair['privateKey'];

async function newKey(kid: string, alg = 'RS256'): Promise<{ kid: string; privateKey: PrivateKey; jwk: JWK }> {
  const { publicKey, privateKey } = await generateKeyPair(alg as 'RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { kid, privateKey, jwk: { ...jwk, kid, alg, use: 'sig' } };
}

interface SignOptions {
  kid: string;
  privateKey: PrivateKey;
  alg?: string;
  typ?: string;
  iss?: string;
  aud?: string | string[];
  sub?: string | null;
  expSecondsFromNow?: number;
  nbfSecondsFromNow?: number;
  claims?: Record<string, unknown>;
}

async function sign(o: SignOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ token_use: 'access', ...(o.claims ?? {}) })
    .setProtectedHeader({ alg: o.alg ?? 'RS256', kid: o.kid, ...(o.typ ? { typ: o.typ } : {}) })
    .setIssuer(o.iss ?? ISSUER)
    .setAudience(o.aud ?? AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + (o.expSecondsFromNow ?? 3600));
  if (o.sub !== null) jwt.setSubject(o.sub ?? 'user-123');
  if (o.nbfSecondsFromNow !== undefined) jwt.setNotBefore(now + o.nbfSecondsFromNow);
  return jwt.sign(o.privateKey);
}

/** Mutable state the fake JWKS/discovery server serves. */
const state: { keys: JWK[]; mode: 'ok' | 'fail'; discoveryIssuer: string } = {
  keys: [],
  mode: 'ok',
  discoveryIssuer: ISSUER,
};

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (state.mode === 'fail') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('jwks unavailable');
      return;
    }
    if (req.url === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: state.keys }));
      return;
    }
    if (req.url === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ issuer: state.discoveryIssuer, jwks_uri: `${base}/jwks` }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no server address');
  base = `http://127.0.0.1:${addr.port}`;
  // Discovery must advertise the issuer we actually verify against.
  state.discoveryIssuer = base;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function cfg(overrides: Partial<OidcVerifierConfig> = {}, includeJwks = true): OidcVerifierConfig {
  const c: OidcVerifierConfig = {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ['RS256'],
    clockToleranceS: 0,
    tokenUseClaim: 'token_use',
    tokenUseValue: 'access',
    requireTokenUse: false,
    jwksCacheMaxAgeS: 0,
    jwksCooldownS: 0,
    ...overrides,
  };
  if (includeJwks && c.jwksUrl === undefined) c.jwksUrl = `${base}/jwks`;
  return c;
}

describe('JoseAccessTokenVerifier — happy path', () => {
  it('accepts a valid access token and returns issuer + subject', async () => {
    const k = await newKey('k-ok');
    state.keys = [k.jwk];
    const token = await sign({ kid: k.kid, privateKey: k.privateKey, sub: 'user-42' });

    const result = await new JoseAccessTokenVerifier(cfg()).verify(token);
    expect(result).toMatchObject({ issuer: ISSUER, subject: 'user-42' });
  });

  it('resolves JWKS via OIDC discovery when no JWKS URL is configured', async () => {
    const k = await newKey('k-disc');
    state.keys = [k.jwk];
    const token = await sign({ kid: k.kid, privateKey: k.privateKey, iss: base });

    const result = await new JoseAccessTokenVerifier(cfg({ issuer: base }, false)).verify(token);
    expect(result.issuer).toBe(base);
  });

  it('rejects when the discovery document advertises a different issuer', async () => {
    const k = await newKey('k-disc2');
    state.keys = [k.jwk];
    const prev = state.discoveryIssuer;
    state.discoveryIssuer = 'https://evil.example.test/';
    try {
      const token = await sign({ kid: k.kid, privateKey: k.privateKey, iss: base });
      await expect(
        new JoseAccessTokenVerifier(cfg({ issuer: base }, false)).verify(token),
      ).rejects.toThrow(/discovery document is invalid or mismatched/);
    } finally {
      state.discoveryIssuer = prev;
    }
  });
});

describe('JoseAccessTokenVerifier — rejects bad tokens', () => {
  it('rejects a malformed token', async () => {
    const v = new JoseAccessTokenVerifier(cfg());
    await expect(v.verify('not-a-jwt')).rejects.toThrow(/malformed/);
    await expect(v.verify('a.b')).rejects.toThrow(/malformed/);
  });

  it('rejects a token signed by a non-trusted key (bad signature)', async () => {
    const trusted = await newKey('k-bad');
    const attacker = await newKey('k-bad');
    state.keys = [trusted.jwk];
    // Same kid, attacker's private key ⇒ signature does not verify.
    const token = await sign({ kid: 'k-bad', privateKey: attacker.privateKey });

    await expect(new JoseAccessTokenVerifier(cfg()).verify(token)).rejects.toThrow(/token verification failed/);
  });

  it('rejects an expired token', async () => {
    const k = await newKey('k-exp');
    state.keys = [k.jwk];
    const token = await sign({ kid: k.kid, privateKey: k.privateKey, expSecondsFromNow: -60 });
    await expect(new JoseAccessTokenVerifier(cfg()).verify(token)).rejects.toThrow(/token verification failed/);
  });

  it('rejects a token that is not yet valid (nbf in the future)', async () => {
    const k = await newKey('k-nbf');
    state.keys = [k.jwk];
    const token = await sign({ kid: k.kid, privateKey: k.privateKey, nbfSecondsFromNow: 300 });
    await expect(new JoseAccessTokenVerifier(cfg()).verify(token)).rejects.toThrow(/token verification failed/);
  });

  it('rejects a wrong issuer', async () => {
    const k = await newKey('k-iss');
    state.keys = [k.jwk];
    const token = await sign({ kid: k.kid, privateKey: k.privateKey, iss: 'https://other.example/' });
    await expect(new JoseAccessTokenVerifier(cfg()).verify(token)).rejects.toThrow(/token verification failed/);
  });

  it('rejects a wrong audience', async () => {
    const k = await newKey('k-aud');
    state.keys = [k.jwk];
    const token = await sign({ kid: k.kid, privateKey: k.privateKey, aud: 'https://other-api.example/' });
    await expect(new JoseAccessTokenVerifier(cfg()).verify(token)).rejects.toThrow(/token verification failed/);
  });

  it('rejects a disallowed signing algorithm', async () => {
    const k = await newKey('k-alg', 'RS512');
    state.keys = [k.jwk];
    // Signed RS512 while only RS256 is permitted.
    const token = await sign({ kid: k.kid, privateKey: k.privateKey, alg: 'RS512' });
    await expect(new JoseAccessTokenVerifier(cfg()).verify(token)).rejects.toThrow(/token verification failed/);
  });

  it('rejects a token with an unknown signing key (no unverified fallback)', async () => {
    const k = await newKey('k-known');
    const other = await newKey('k-unknown');
    state.keys = [k.jwk]; // JWKS deliberately omits `other`
    const token = await sign({ kid: other.kid, privateKey: other.privateKey });
    await expect(new JoseAccessTokenVerifier(cfg()).verify(token)).rejects.toThrow(/token verification failed/);
  });

  it('rejects a token missing the subject claim', async () => {
    const k = await newKey('k-nosub');
    state.keys = [k.jwk];
    const token = await sign({ kid: k.kid, privateKey: k.privateKey, sub: null });
    await expect(new JoseAccessTokenVerifier(cfg()).verify(token)).rejects.toThrow(/token verification failed/);
  });

  it('rejects an ID token (token_use=id)', async () => {
    const k = await newKey('k-id');
    state.keys = [k.jwk];
    const token = await sign({ kid: k.kid, privateKey: k.privateKey, claims: { token_use: 'id' } });
    await expect(new JoseAccessTokenVerifier(cfg()).verify(token)).rejects.toThrow(/not an access token/);
  });

  it('can require the token-use claim outright', async () => {
    const k = await newKey('k-requse');
    state.keys = [k.jwk];
    const token = await sign({ kid: k.kid, privateKey: k.privateKey, claims: { token_use: undefined } });
    await expect(new JoseAccessTokenVerifier(cfg({ requireTokenUse: true })).verify(token)).rejects.toThrow(
      /missing token-use claim/,
    );
  });

  it('can require an RFC 9068 `typ` header', async () => {
    const k = await newKey('k-typ');
    state.keys = [k.jwk];
    const plain = await sign({ kid: k.kid, privateKey: k.privateKey });
    await expect(new JoseAccessTokenVerifier(cfg({ accessTokenTyp: 'at+jwt' })).verify(plain)).rejects.toThrow(
      /unexpected token type/,
    );

    const at = await sign({ kid: k.kid, privateKey: k.privateKey, typ: 'at+jwt' });
    await expect(new JoseAccessTokenVerifier(cfg({ accessTokenTyp: 'at+jwt' })).verify(at)).resolves.toMatchObject({
      issuer: ISSUER,
    });
  });
});

describe('JoseAccessTokenVerifier — key rotation', () => {
  it('verifies with a newly rotated-in key and still accepts the old key', async () => {
    const k1 = await newKey('k-rot-1');
    state.keys = [k1.jwk];
    const v = new JoseAccessTokenVerifier(cfg());

    const t1 = await sign({ kid: k1.kid, privateKey: k1.privateKey, sub: 'first' });
    await expect(v.verify(t1)).resolves.toMatchObject({ subject: 'first' });

    // Rotate: publish a new key alongside the old one.
    const k2 = await newKey('k-rot-2');
    state.keys = [k1.jwk, k2.jwk];
    const t2 = await sign({ kid: k2.kid, privateKey: k2.privateKey, sub: 'second' });

    await expect(v.verify(t2)).resolves.toMatchObject({ subject: 'second' });
    await expect(v.verify(t1)).resolves.toMatchObject({ subject: 'first' });
  });
});

describe('JoseAccessTokenVerifier — JWKS failures never fall back', () => {
  it('rejects when the JWKS endpoint is unreachable (no cached key)', async () => {
    const dead = 'http://127.0.0.1:1/jwks'; // nothing listens here
    const k = await newKey('k-dead');
    const token = await sign({ kid: k.kid, privateKey: k.privateKey });
    await expect(new JoseAccessTokenVerifier(cfg({ jwksUrl: dead })).verify(token)).rejects.toThrow(
      /token verification failed/,
    );
  });

  it('rejects an unknown-kid token when the JWKS endpoint starts failing', async () => {
    const k1 = await newKey('k-fail-1');
    state.mode = 'ok';
    state.keys = [k1.jwk];
    const v = new JoseAccessTokenVerifier(cfg());
    await expect(v.verify(await sign({ kid: k1.kid, privateKey: k1.privateKey }))).resolves.toBeTruthy();

    // Endpoint goes down; a token with a key we never cached must be rejected.
    state.mode = 'fail';
    try {
      const k2 = await newKey('k-fail-2');
      const token = await sign({ kid: k2.kid, privateKey: k2.privateKey });
      await expect(v.verify(token)).rejects.toThrow(/token verification failed/);
    } finally {
      state.mode = 'ok';
    }
  });
});
