/**
 * DFAP1 connect tokens — opaque capability handles (ADR-002).
 *
 * `DFAP1.<b64url(header)>.<b64url(payload)>.<b64url(HMAC-SHA256(key, h.p))>`
 *
 * The token names a session (`sid`) and nothing else: no hostname, no
 * username, no password, no connection parameters. The broker resolves the
 * sid server-side and fetches credentials from Vault at connect time.
 *
 * Hard rules encoded here:
 *  - the verifier pins HS256; `header.alg` is never consulted for dispatch
 *  - signatures compare in constant time
 *  - 60 s TTL, single-use `jti` burned via a NonceStore; a replayed token is
 *    a compromise signal and the caller must terminate the session
 *  - keys rotate via `kid`; verification accepts any key in the ring,
 *    minting always uses the ring's designated signing key
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NonceStore } from './nonce-store.js';

export const TOKEN_PREFIX = 'DFAP1';
export const CONNECT_TOKEN_TTL_S = 60;
/** Grace window for jti burn records beyond token expiry. */
const NONCE_TTL_S = 120;
const CLOCK_SKEW_S = 5;

export interface TokenHeader {
  alg: 'HS256';
  typ: 'dfap-conn' | 'dfap-reconn';
  kid: string;
}

export interface ConnectTokenPayload {
  sid: string;
  sub: string;
  org: string;
  aud: 'broker';
  iat: number;
  exp: number;
  jti: string;
  /** Advisory channel binding: sha256(clientIpPrefix|userAgent) hex, first 16 chars. */
  cbh?: string;
  scp: string[];
}

export interface Keyring {
  /** kid → key. All entries verify; `signingKid` mints. */
  keys: ReadonlyMap<string, Buffer>;
  signingKid: string;
}

export type VerifyResult =
  | { ok: true; payload: ConnectTokenPayload }
  | { ok: false; reason: VerifyFailure; terminateSession?: boolean };

export type VerifyFailure =
  | 'malformed'
  | 'bad_prefix'
  | 'bad_header'
  | 'alg_not_pinned'
  | 'wrong_type'
  | 'unknown_kid'
  | 'bad_signature'
  | 'bad_payload'
  | 'expired'
  | 'not_yet_valid'
  | 'wrong_audience'
  | 'missing_scope'
  | 'replayed';

const b64u = (b: Buffer): string => b.toString('base64url');
const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url');

function sign(key: Buffer, signingInput: string): Buffer {
  return createHmac('sha256', key).update(signingInput).digest();
}

export interface MintInput {
  sid: string;
  sub: string;
  org: string;
  cbh?: string;
  typ?: TokenHeader['typ'];
  ttlSeconds?: number;
  now?: number; // epoch seconds, injectable for tests
}

export function mintConnectToken(input: MintInput, keyring: Keyring): string {
  const key = keyring.keys.get(keyring.signingKid);
  if (!key) throw new Error(`signing kid ${keyring.signingKid} not in keyring`);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const header: TokenHeader = { alg: 'HS256', typ: input.typ ?? 'dfap-conn', kid: keyring.signingKid };
  const payload: ConnectTokenPayload = {
    sid: input.sid,
    sub: input.sub,
    org: input.org,
    aud: 'broker',
    iat: now,
    exp: now + (input.ttlSeconds ?? CONNECT_TOKEN_TTL_S),
    jti: randomBytes(16).toString('hex'),
    ...(input.cbh !== undefined ? { cbh: input.cbh } : {}),
    scp: ['connect'],
  };
  const h = b64u(Buffer.from(JSON.stringify(header)));
  const p = b64u(Buffer.from(JSON.stringify(payload)));
  const sig = b64u(sign(key, `${h}.${p}`));
  return `${TOKEN_PREFIX}.${h}.${p}.${sig}`;
}

export interface VerifyOptions {
  expectedTyp?: TokenHeader['typ'];
  now?: number;
}

export async function verifyConnectToken(
  token: string,
  keyring: Keyring,
  nonces: NonceStore,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const parts = token.split('.');
  if (parts.length !== 4) return { ok: false, reason: 'malformed' };
  const [prefix, h, p, s] = parts as [string, string, string, string];
  if (prefix !== TOKEN_PREFIX) return { ok: false, reason: 'bad_prefix' };

  let header: unknown;
  try {
    header = JSON.parse(fromB64u(h).toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad_header' };
  }
  if (typeof header !== 'object' || header === null) return { ok: false, reason: 'bad_header' };
  const hdr = header as Record<string, unknown>;

  // Pin the algorithm. We do not dispatch on header.alg — we *require* it to
  // literally be HS256 and always verify with HMAC-SHA256 regardless.
  if (hdr['alg'] !== 'HS256') return { ok: false, reason: 'alg_not_pinned' };
  const expectedTyp = opts.expectedTyp ?? 'dfap-conn';
  if (hdr['typ'] !== expectedTyp) return { ok: false, reason: 'wrong_type' };
  if (typeof hdr['kid'] !== 'string') return { ok: false, reason: 'bad_header' };

  const key = keyring.keys.get(hdr['kid']);
  if (!key) return { ok: false, reason: 'unknown_kid' };

  const expected = sign(key, `${h}.${p}`);
  const provided = fromB64u(s);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Signature is valid — everything below trusts the payload's authenticity.
  let payload: ConnectTokenPayload;
  try {
    payload = JSON.parse(fromB64u(p).toString('utf8')) as ConnectTokenPayload;
  } catch {
    return { ok: false, reason: 'bad_payload' };
  }
  if (
    typeof payload.sid !== 'string' ||
    typeof payload.sub !== 'string' ||
    typeof payload.org !== 'string' ||
    typeof payload.jti !== 'string' ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number' ||
    !Array.isArray(payload.scp)
  ) {
    return { ok: false, reason: 'bad_payload' };
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (now >= payload.exp) return { ok: false, reason: 'expired' };
  if (payload.iat > now + CLOCK_SKEW_S) return { ok: false, reason: 'not_yet_valid' };
  if (payload.aud !== 'broker') return { ok: false, reason: 'wrong_audience' };
  if (!payload.scp.includes('connect')) return { ok: false, reason: 'missing_scope' };

  const firstUse = await nonces.burn(`dfap:jti:${payload.jti}`, NONCE_TTL_S);
  if (!firstUse) {
    // Replay of a validly signed token = the token leaked somewhere.
    // The caller must terminate the session it names, not just reject.
    return { ok: false, reason: 'replayed', terminateSession: true };
  }

  return { ok: true, payload };
}
