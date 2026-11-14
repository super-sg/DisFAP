import { describe, expect, it } from 'vitest';

import {
  PairKeyFormatError,
  PairKeyIntegrityError,
  PairKeyService,
  devFallbackMasterSeed,
} from '../src/crypto/pair-keys.js';

const MASTER = Buffer.alloc(32, 7);
const svc = new PairKeyService(MASTER);

const OWNER = 'owner_matlab_edu';
const RENTEE = 'rentee_student_42';

describe('PairKeyService — unique per owner-rentee key (spec TA-4)', () => {
  it('requires a ≥32-byte master seed', () => {
    expect(() => new PairKeyService(Buffer.alloc(16, 1))).toThrow(/32 bytes/);
  });

  it('derives a stable key for a pair, distinct across pairs', () => {
    const k1 = svc.keyFor(OWNER, RENTEE);
    const k2 = svc.keyFor(OWNER, RENTEE);
    expect(k1.equals(k2)).toBe(true);
    expect(k1.equals(svc.keyFor(OWNER, 'rentee_other'))).toBe(false);
    expect(k1.equals(svc.keyFor('owner_other', RENTEE))).toBe(false);
    expect(k1.length).toBe(32);
  });

  it('treats (owner, rentee) and (rentee, owner) as the same pair', () => {
    expect(svc.keyFor(OWNER, RENTEE).equals(svc.keyFor(RENTEE, OWNER))).toBe(true);
  });

  it('round-trips a credential and never exposes plaintext in the payload', () => {
    const secret = JSON.stringify({ username: 'matlab_user', password: 'DisFAP_Session_Password_2026!' });
    const payload = svc.encrypt(OWNER, RENTEE, secret);

    expect(payload.v).toBe(1);
    expect(payload.alg).toBe('AES-256-GCM-HKDF');
    // The password must not appear anywhere in the sealed payload.
    expect(JSON.stringify(payload)).not.toContain('DisFAP_Session_Password_2026!');
    expect(svc.decrypt(OWNER, RENTEE, payload)).toBe(secret);
  });

  it('uses a fresh nonce per encryption (no payload reuse)', () => {
    const a = svc.encrypt(OWNER, RENTEE, 'same');
    const b = svc.encrypt(OWNER, RENTEE, 'same');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('refuses to open a payload sealed for a different pair', () => {
    const payload = svc.encrypt(OWNER, RENTEE, 'secret');
    expect(() => svc.decrypt(OWNER, 'someone_else', payload)).toThrow(PairKeyIntegrityError);
  });

  it('detects tampering with the ciphertext or fingerprint', () => {
    const payload = svc.encrypt(OWNER, RENTEE, 'secret');
    const flipped = Buffer.from(payload.ct, 'base64');
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    expect(() => svc.decrypt(OWNER, RENTEE, { ...payload, ct: flipped.toString('base64') })).toThrow(
      PairKeyIntegrityError,
    );
    expect(() => svc.decrypt(OWNER, RENTEE, { ...payload, pair: 'deadbeefdeadbeef' })).toThrow(
      PairKeyIntegrityError,
    );
  });

  it('rejects an unsupported payload version/algorithm', () => {
    const payload = svc.encrypt(OWNER, RENTEE, 'secret');
    // @ts-expect-error deliberately invalid version
    expect(() => svc.decrypt(OWNER, RENTEE, { ...payload, v: 2 })).toThrow(PairKeyFormatError);
    // @ts-expect-error deliberately invalid algorithm
    expect(() => svc.decrypt(OWNER, RENTEE, { ...payload, alg: 'AES-128' })).toThrow(PairKeyFormatError);
  });

  it('exposes a deterministic, log-safe fingerprint', () => {
    const fp = svc.fingerprint(OWNER, RENTEE);
    expect(fp).toHaveLength(16);
    expect(fp).toBe(svc.fingerprint(RENTEE, OWNER)); // order-insensitive
    expect(fp).not.toBe(svc.fingerprint(OWNER, 'other'));
  });

  it('parses a base64 master key and derives the dev fallback deterministically', () => {
    const fromB64 = PairKeyService.fromMasterBase64(MASTER.toString('base64'));
    expect(fromB64.keyFor(OWNER, RENTEE).equals(svc.keyFor(OWNER, RENTEE))).toBe(true);
    expect(() => PairKeyService.fromMasterBase64(Buffer.alloc(8).toString('base64'))).toThrow(/32 bytes/);

    const a = devFallbackMasterSeed('pair-dev|kdev');
    const b = devFallbackMasterSeed('pair-dev|kdev');
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32);
    expect(a.equals(devFallbackMasterSeed('pair-dev|other'))).toBe(false);
  });
});
