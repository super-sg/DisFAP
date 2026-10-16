/**
 * Layer 2: credential-key provider (ADR-006 / DisFAP spec Layer 2).
 *
 * The platform seals each owner-submitted software credential at ingest and only
 * reopens it inside the control plane at rent time. This module owns the *shape*
 * of that ciphertext and the provider contract; durable key material is supplied
 * by config (`credential-key-store.ts`).
 *
 * Rules (audit M7):
 *  - `algorithm` / `keyBits` in the payload reflect the key ACTUALLY used. Both
 *    are validated on encrypt and decrypt, and the key is validated on load
 *    (must be RSA, modulus on the allowed list, ≥ the configured minimum).
 *  - `keyFingerprint` is a real key id: SHA-256 of the public key's DER-SPKI.
 *    It is stable across restarts and safe to persist/log (it is public).
 *  - Decryption is fail-closed: an unknown key id, an unexpected algorithm, a
 *    payload/key modulus mismatch, or an unsupported payload version is an
 *    error, never a best-effort guess.
 *  - Private key material is never placed in a payload, an API response, or a
 *    log line. Only the derived public key and its id ever leave the provider.
 *
 * NOTE: this is a software key provider. It offers no hardware-backed
 * protection. Do not describe it as an HSM.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  constants,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  type KeyObject,
} from 'node:crypto';

/** The cipher actually used: RSA-OAEP with SHA-256 (MGF1-SHA256). */
export const CREDENTIAL_ALGORITHM = 'RSA-OAEP-SHA256' as const;
export type CredentialAlgorithm = typeof CREDENTIAL_ALGORITHM;

/** Modulus sizes the provider will load. Anything else is refused outright. */
export const ALLOWED_MODULUS_BITS = [2048, 3072, 4096] as const;

/** Modulus size the platform generates for a new durable key. */
export const DEFAULT_MODULUS_BITS = 4096;

/**
 * Keys smaller than this are refused unless a caller explicitly lowers it
 * (`minModulusBits`, tests only). Production/dev config never lowers it.
 */
export const DEFAULT_MIN_MODULUS_BITS = 3072;

export interface EncryptedCredentialPayload {
  /** Payload format version. v2 added an explicit key id + modulus size. */
  v: 2;
  algorithm: CredentialAlgorithm;
  /** Modulus size (bits) of the key that produced `cipherTextB64`. */
  keyBits: number;
  /** Key id — SHA-256(SPKI DER) hex prefix. Public, stable, safe to log. */
  keyFingerprint: string;
  cipherTextB64: string;
  encryptedAt: string;
}

export interface HsmService {
  readonly algorithm: CredentialAlgorithm;
  readonly keyBits: number;
  encrypt(plaintext: string): EncryptedCredentialPayload;
  decrypt(payload: EncryptedCredentialPayload): string;
  /** Public key (PEM) of the ACTIVE key. Never private material. */
  getPublicKeyPem(): string;
  /** Key id of the ACTIVE key. */
  getKeyFingerprint(): string;
}

export class CredentialKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialKeyError';
  }
}

export interface CredentialKeyMaterial {
  publicKeyPem: string;
  privateKeyPem: string;
  /**
   * Optional id label. Tests use it to assert telemetry; config-loaded keys
   * always derive the id from the public key (never a caller-supplied value).
   */
  keyId?: string;
  /** Refuse keys smaller than this. Defaults to `DEFAULT_MIN_MODULUS_BITS`. */
  minModulusBits?: number;
}

interface ValidatedKey {
  keyId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  bits: number;
}

/** Key id = SHA-256 of the DER-SPKI public key, hex, first 32 chars. */
export function keyIdFromPublicKey(publicKey: KeyObject | string): string {
  const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  return createHash('sha256')
    .update(key.export({ type: 'spki', format: 'der' }))
    .digest('hex')
    .slice(0, 32);
}

function assertRsa(key: KeyObject, label: string): void {
  if (key.asymmetricKeyType !== 'rsa') {
    throw new CredentialKeyError(`${label} must be an RSA key (got ${String(key.asymmetricKeyType)})`);
  }
}

function modulusBits(key: KeyObject, label: string): number {
  const bits = key.asymmetricKeyDetails?.modulusLength;
  if (typeof bits !== 'number' || bits <= 0) {
    throw new CredentialKeyError(`${label} has no readable RSA modulus length`);
  }
  return bits;
}

/**
 * Validate a public/private RSA pair and derive its canonical key id. Throws
 * `CredentialKeyError` for a non-RSA key, a disallowed/short modulus, a
 * mismatched pair, or unparseable PEM.
 */
export function validateCredentialKey(material: CredentialKeyMaterial): ValidatedKey {
  const minBits = material.minModulusBits ?? DEFAULT_MIN_MODULUS_BITS;
  let publicKey: KeyObject;
  let privateKey: KeyObject;
  try {
    publicKey = createPublicKey(material.publicKeyPem);
    privateKey = createPrivateKey(material.privateKeyPem);
  } catch {
    throw new CredentialKeyError('credential key material is not a valid PEM key');
  }
  assertRsa(publicKey, 'public key');
  assertRsa(privateKey, 'private key');

  const bits = modulusBits(publicKey, 'public key');
  if (!(ALLOWED_MODULUS_BITS as readonly number[]).includes(bits)) {
    throw new CredentialKeyError(
      `RSA modulus ${bits} bits is not permitted (allowed: ${ALLOWED_MODULUS_BITS.join(', ')})`,
    );
  }
  if (bits < minBits) {
    throw new CredentialKeyError(`RSA modulus ${bits} bits is below the required minimum of ${minBits}`);
  }

  // The private key must actually correspond to the public key.
  const derivedId = keyIdFromPublicKey(publicKey);
  if (keyIdFromPublicKey(createPublicKey(privateKey)) !== derivedId) {
    throw new CredentialKeyError('credential public and private key do not match');
  }

  return {
    keyId: material.keyId ?? derivedId,
    publicKeyPem: material.publicKeyPem,
    privateKeyPem: material.privateKeyPem,
    bits,
  };
}

/** Generate fresh RSA key material. Used by the durable store and tests. */
export function generateCredentialKeyMaterial(bits: number = DEFAULT_MODULUS_BITS): CredentialKeyMaterial {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: bits,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

/**
 * The concrete software provider. Holds one active key (used to encrypt) plus
 * any retired keys (decrypt-only, kept for rotation).
 */
class RsaCredentialHsm implements HsmService {
  private readonly active: ValidatedKey;
  private readonly keys: ReadonlyMap<string, ValidatedKey>;

  constructor(active: ValidatedKey, keys: ReadonlyMap<string, ValidatedKey>) {
    this.active = active;
    this.keys = keys;
  }

  get algorithm(): CredentialAlgorithm {
    return CREDENTIAL_ALGORITHM;
  }

  get keyBits(): number {
    return this.active.bits;
  }

  getPublicKeyPem(): string {
    return this.active.publicKeyPem;
  }

  getKeyFingerprint(): string {
    return this.active.keyId;
  }

  encrypt(plaintext: string): EncryptedCredentialPayload {
    const encrypted = publicEncrypt(
      { key: this.active.publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(plaintext, 'utf-8'),
    );
    return {
      v: 2,
      algorithm: CREDENTIAL_ALGORITHM,
      keyBits: this.active.bits,
      keyFingerprint: this.active.keyId,
      cipherTextB64: encrypted.toString('base64'),
      encryptedAt: new Date().toISOString(),
    };
  }

  decrypt(payload: EncryptedCredentialPayload): string {
    if (!payload || payload.v !== 2) {
      throw new CredentialKeyError('unsupported credential payload (expected v2)');
    }
    if (payload.algorithm !== CREDENTIAL_ALGORITHM) {
      throw new CredentialKeyError(`unsupported credential algorithm ${String(payload.algorithm)}`);
    }
    if (!(ALLOWED_MODULUS_BITS as readonly number[]).includes(payload.keyBits)) {
      throw new CredentialKeyError(`unsupported credential key size ${String(payload.keyBits)}`);
    }
    const key = this.keys.get(payload.keyFingerprint);
    if (!key) {
      throw new CredentialKeyError(`no credential key available for id ${String(payload.keyFingerprint)}`);
    }
    if (key.bits !== payload.keyBits) {
      throw new CredentialKeyError(
        `credential payload key size ${payload.keyBits} does not match key ${key.keyId} (${key.bits})`,
      );
    }
    try {
      return privateDecrypt(
        { key: key.privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(payload.cipherTextB64, 'base64'),
      ).toString('utf-8');
    } catch {
      throw new CredentialKeyError('credential payload failed to decrypt (tampered or sealed by another key)');
    }
  }
}

/** Single active key. Material is REQUIRED — there is no implicit generation. */
export class SoftwareHsm extends RsaCredentialHsm {
  constructor(material: CredentialKeyMaterial) {
    const active = validateCredentialKey(material);
    super(active, new Map([[active.keyId, active]]));
  }
}

/**
 * Active key for encryption + retired keys for decryption only. A payload
 * carries the id of the key that sealed it, so rotating the active key does not
 * strand older ciphertext.
 */
export class RotatingCredentialHsm extends RsaCredentialHsm {
  constructor(activeMaterial: CredentialKeyMaterial, retiredMaterials: readonly CredentialKeyMaterial[] = []) {
    const active = validateCredentialKey(activeMaterial);
    const keys = new Map<string, ValidatedKey>([[active.keyId, active]]);
    for (const material of retiredMaterials) {
      const key = validateCredentialKey(material);
      if (keys.has(key.keyId)) {
        throw new CredentialKeyError(`duplicate credential key id ${key.keyId}`);
      }
      keys.set(key.keyId, key);
    }
    super(active, keys);
  }
}

/**
 * Explicitly ephemeral provider for tests and short-lived local fixtures.
 * Deliberately named so no config path can select it by accident: the key is
 * lost on restart, so any ciphertext it produced becomes unreadable.
 */
export function generateEphemeralHsm(bits: number = DEFAULT_MODULUS_BITS): SoftwareHsm {
  return new SoftwareHsm({ ...generateCredentialKeyMaterial(bits), minModulusBits: 2048 });
}
