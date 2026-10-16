import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  CREDENTIAL_ALGORITHM,
  CredentialKeyError,
  RotatingCredentialHsm,
  SoftwareHsm,
  generateEphemeralHsm,
  keyIdFromPublicKey,
  validateCredentialKey,
  type CredentialKeyMaterial,
  type EncryptedCredentialPayload,
} from '../src/crypto/hsm-rsa.js';
import { createCredentialHsm, loadOrCreateCredentialKeyFile } from '../src/crypto/credential-key-store.js';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'dfap-keys-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A fresh 2048-bit key (fast) with an explicitly lowered floor for tests. */
function fastKey(): CredentialKeyMaterial & { minModulusBits: number } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey, minModulusBits: 2048 };
}

describe('credential key material — validation', () => {
  it('reports the algorithm and modulus it actually uses', () => {
    const hsm = new SoftwareHsm(fastKey());
    const payload = hsm.encrypt('hello');
    expect(payload).toMatchObject({ v: 2, algorithm: CREDENTIAL_ALGORITHM, keyBits: 2048 });
    expect(hsm.algorithm).toBe(CREDENTIAL_ALGORITHM);
    expect(hsm.keyBits).toBe(2048);
  });

  it('derives a stable key id from the public key (SHA-256 prefix)', () => {
    const key = fastKey();
    expect(keyIdFromPublicKey(key.publicKeyPem)).toMatch(/^[0-9a-f]{32}$/);
    expect(keyIdFromPublicKey(key.publicKeyPem)).toBe(keyIdFromPublicKey(key.publicKeyPem));
    // And it is the id the provider stamps into payloads.
    const hsm = new SoftwareHsm(key);
    expect(hsm.getKeyFingerprint()).toBe(keyIdFromPublicKey(key.publicKeyPem));
  });

  it('never exposes private key material via the public accessor', () => {
    const hsm = new SoftwareHsm(fastKey());
    expect(hsm.getPublicKeyPem()).toContain('BEGIN PUBLIC KEY');
    expect(hsm.getPublicKeyPem()).not.toContain('PRIVATE');
  });

  it('refuses a modulus below the configured minimum', () => {
    const key = fastKey(); // 2048
    expect(() => validateCredentialKey({ ...key, minModulusBits: 3072 })).toThrow(/below the required minimum/);
    // The default minimum (3072) also refuses 2048 unless explicitly lowered.
    expect(() => new SoftwareHsm({ publicKeyPem: key.publicKeyPem, privateKeyPem: key.privateKeyPem })).toThrow(
      /below the required minimum/,
    );
  });

  it('refuses a modulus that is not on the allowed list', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 1024,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    expect(() => validateCredentialKey({ publicKeyPem: publicKey, privateKeyPem: privateKey, minModulusBits: 1024 })).toThrow(
      /not permitted/,
    );
  });

  it('refuses a public/private pair that does not match', () => {
    const a = fastKey();
    const b = fastKey();
    expect(() => validateCredentialKey({ publicKeyPem: a.publicKeyPem, privateKeyPem: b.privateKeyPem, minModulusBits: 2048 })).toThrow(
      /do not match/,
    );
  });

  it('explicitly-ephemeral providers do not share a key', () => {
    const a = generateEphemeralHsm(2048);
    const b = generateEphemeralHsm(2048);
    expect(a.getKeyFingerprint()).not.toBe(b.getKeyFingerprint());
    expect(() => b.decrypt(a.encrypt('x'))).toThrow(CredentialKeyError);
  });
});

describe('credential ciphertext — wrong key, tampering, algorithm consistency', () => {
  it('round-trips plaintext with the same key', () => {
    const hsm = new SoftwareHsm(fastKey());
    expect(hsm.decrypt(hsm.encrypt('s3cret'))).toBe('s3cret');
  });

  it('fails to decrypt under a different key (wrong key id)', () => {
    const a = new SoftwareHsm(fastKey());
    const b = new SoftwareHsm(fastKey());
    expect(() => b.decrypt(a.encrypt('x'))).toThrow(/no credential key available/);
  });

  it('fails on tampered ciphertext', () => {
    const hsm = new SoftwareHsm(fastKey());
    const payload = hsm.encrypt('x');
    const raw = Buffer.from(payload.cipherTextB64, 'base64');
    raw[10] = raw[10]! ^ 0xff;
    payload.cipherTextB64 = raw.toString('base64');
    expect(() => hsm.decrypt(payload)).toThrow(/failed to decrypt/);
  });

  it('rejects a payload that claims an unexpected algorithm', () => {
    const hsm = new SoftwareHsm(fastKey());
    const payload = { ...hsm.encrypt('x'), algorithm: 'RSA-OAEP-4096' } as unknown as EncryptedCredentialPayload;
    expect(() => hsm.decrypt(payload)).toThrow(/unsupported credential algorithm/);
  });

  it('rejects a payload whose declared key size does not match the key', () => {
    const hsm = new SoftwareHsm(fastKey());
    const payload = { ...hsm.encrypt('x'), keyBits: 4096 };
    expect(() => hsm.decrypt(payload)).toThrow(/does not match key/);
  });

  it('rejects a payload with an unsupported version', () => {
    const hsm = new SoftwareHsm(fastKey());
    const payload = { ...hsm.encrypt('x'), v: 1 } as unknown as EncryptedCredentialPayload;
    expect(() => hsm.decrypt(payload)).toThrow(/unsupported credential payload/);
  });
});

describe('durable key storage — restart persistence', () => {
  it('encrypts in one instance and decrypts after constructing a new instance', () => {
    const file = join(tempDir(), 'credential-key.pem');
    const first = createCredentialHsm({ file, retiredPems: [] }, { production: false, minModulusBits: 2048 });
    const payload = first.encrypt('across-restarts');

    // A brand-new provider built from the same file (a process restart).
    const second = createCredentialHsm({ file, retiredPems: [] }, { production: false, minModulusBits: 2048 });
    expect(second.getKeyFingerprint()).toBe(first.getKeyFingerprint());
    expect(second.decrypt(payload)).toBe('across-restarts');
  });

  it('creates the key file 0600 and reuses it', () => {
    const file = join(tempDir(), 'nested', 'credential-key.pem');
    loadOrCreateCredentialKeyFile(file, { bits: 2048, minModulusBits: 2048 });
    expect(statSync(file).mode & 0o077).toBe(0);
    const before = readFileSync(file, 'utf8');
    loadOrCreateCredentialKeyFile(file, { bits: 2048, minModulusBits: 2048 });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('uses the dev default file only when not production', () => {
    const devFile = join(tempDir(), 'dev-default.pem');
    const hsm = createCredentialHsm(undefined, { production: false, devDefaultFile: devFile, minModulusBits: 2048 });
    const payload = hsm.encrypt('dev');
    expect(
      createCredentialHsm(undefined, { production: false, devDefaultFile: devFile, minModulusBits: 2048 }).decrypt(payload),
    ).toBe('dev');
  });

  it('fails closed when production has no durable key configured', () => {
    expect(() => createCredentialHsm(undefined, { production: true, devDefaultFile: join(tempDir(), 'x.pem') })).toThrow(
      /no durable credential key configured/,
    );
  });

  it('loads the active key from base64 PEM (env-injected)', () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const b64 = Buffer.from(privateKey, 'utf8').toString('base64');
    const hsm = createCredentialHsm({ pem: b64, retiredPems: [] }, { production: false, minModulusBits: 2048 });
    expect(hsm.decrypt(hsm.encrypt('env-key'))).toBe('env-key');
  });
});

describe('credential key rotation (retired keys, decrypt-only)', () => {
  function material(min = 2048): CredentialKeyMaterial {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: min,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return { publicKeyPem: publicKey, privateKeyPem: privateKey, minModulusBits: 2048 };
  }

  it('decrypts payloads sealed by a retired key while encrypting with the active one', () => {
    const retired = material();
    const active = material();
    const oldHsm = new SoftwareHsm(retired);
    const oldPayload = oldHsm.encrypt('legacy');

    const rotating = new RotatingCredentialHsm(active, [retired]);
    expect(rotating.decrypt(oldPayload)).toBe('legacy');
    const fresh = rotating.encrypt('fresh');
    expect(fresh.keyFingerprint).toBe(rotating.getKeyFingerprint());
    expect(rotating.getKeyFingerprint()).not.toBe(oldHsm.getKeyFingerprint());
    expect(rotating.decrypt(fresh)).toBe('fresh');
  });

  it('refuses duplicate key ids', () => {
    const key = material();
    expect(() => new RotatingCredentialHsm(key, [key])).toThrow(/duplicate credential key id/);
  });
});
