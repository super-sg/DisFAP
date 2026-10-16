/**
 * Pair keys — the unique per owner-rentee credential encryption key
 * (DisFAP spec, Technical Advancement 4):
 *
 *   "Every owner-renter pair gets a unique encryption key built by utilizing
 *    both of their ids. This simplifies access control for specific pairs
 *    and sessions."
 *
 * The key is NOT stored anywhere: it is derived on the fly from a
 * platform master secret via HKDF-SHA256, binding both ids. Two
 * consequences:
 *  - Only a tenant whose (ownerId, renteeId) pair matches can open a payload
 *    (the ids are also bound as AEAD associated data, so tampering with a row
 *    to swap ids on a ciphertext fails the GCM tag).
 *  - The master secret is the only thing that needs protecting at rest —
 *    production keeps it in an HSM/Vault Transit; SoftwareHsm-based dev
 *    fallback derives it from the process key material.
 *
 * Layering: the HSM payload (layer 2) is the *owner-at-rest* encryption the
 * platform holds continuously; a pair-key payload is the *rental-scoped*
 * re-seal minted at rent time (layer 3) so the credential handed downstream
 * is pinned to exactly one owner, one rentee, one session.
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

export interface PairEncryptedPayload {
  v: 1;
  alg: 'AES-256-GCM-HKDF';
  /** base64 12-byte GCM nonce. Unique per encryption. */
  iv: string;
  /** base64 GCM authentication tag. */
  tag: string;
  /** base64 ciphertext. */
  ct: string;
  /** Short fingerprint of the derived pair key — safe to log/audit. */
  pair: string;
}

export class PairKeyIntegrityError extends Error {
  readonly statusCode = 403;
  constructor(message = 'pair-sealed payload failed integrity check (wrong pair or tampered data)') {
    super(message);
    this.name = 'PairKeyIntegrityError';
  }
}

export class PairKeyFormatError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'PairKeyFormatError';
  }
}

const VERSION = 1 as const;
const ALG: PairEncryptedPayload['alg'] = 'AES-256-GCM-HKDF';

export class PairKeyService {
  /**
   * @param masterSeed ≥32 bytes of platform secret. Never derived from any
   *   tenant id alone — an id pair is public knowledge.
   */
  constructor(private readonly masterSeed: Buffer) {
    if (!Buffer.isBuffer(masterSeed) || masterSeed.length < 32) {
      throw new Error('PairKeyService requires a master seed of at least 32 bytes');
    }
  }

  /** Parse a base64 `DFAP_PAIR_MASTER_KEY` (the canonical production config). */
  static fromMasterBase64(b64: string): PairKeyService {
    const seed = Buffer.from(b64, 'base64');
    if (seed.length < 32) {
      throw new Error('DFAP_PAIR_MASTER_KEY must decode to at least 32 bytes');
    }
    return new PairKeyService(seed);
  }

  /**
   * The pair key. `hkdfSync` binds salt=ownerId and info=renteeId; ids are
   * canonicalised so (A,B) and (B,A) name the same lease relationship.
   */
  keyFor(ownerId: string, renteeId: string): Buffer {
    const sorted = [ownerId, renteeId].sort();
    const first = sorted[0] as string;
    const second = sorted[1] as string;
    return Buffer.from(
      hkdfSync(
        'sha256',
        this.masterSeed,
        Buffer.from(first, 'utf8'),
        Buffer.from(`dfap:pair-credential-v1|${second}`, 'utf8'),
        32,
      ),
    );
  }

  /** Deterministic, log-safe fingerprint of a pair's key (audit correlation). */
  fingerprint(ownerId: string, renteeId: string): string {
    return createHash('sha256').update(this.keyFor(ownerId, renteeId)).digest('hex').slice(0, 16);
  }

  /** Seal `plaintext` for exactly this owner-rentee pair. */
  encrypt(ownerId: string, renteeId: string, plaintext: string): PairEncryptedPayload {
    const key = this.keyFor(ownerId, renteeId);
    const iv = randomBytes(12);
    // AAD binds the ids and the claimed fingerprint into the tag: a payload
    // moved to another pair, or a rewritten fingerprint, fails to open.
    const aad = this.aad(ownerId, renteeId, this.pairFingerprint(key));
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(aad);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      v: VERSION,
      alg: ALG,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ct.toString('base64'),
      pair: this.pairFingerprint(key),
    };
  }

  /** Open a pair-sealed payload. Throws `PairKeyFormatError`/`PairKeyIntegrityError`. */
  decrypt(ownerId: string, renteeId: string, payload: PairEncryptedPayload): string {
    if (payload?.v !== VERSION || payload?.alg !== ALG) {
      throw new PairKeyFormatError(`unsupported pair payload ${JSON.stringify(payload?.v)}/${payload?.alg}`);
    }
    if (!payload.iv || !payload.tag || !payload.ct) {
      throw new PairKeyFormatError('pair payload missing iv/tag/ct');
    }
    const key = this.keyFor(ownerId, renteeId);
    const expectedPair = this.pairFingerprint(key);
    if (payload.pair !== expectedPair) {
      throw new PairKeyIntegrityError('pair fingerprint mismatch (payload sealed for a different pair)');
    }
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'), { authTagLength: 16 });
    decipher.setAAD(this.aad(ownerId, renteeId, expectedPair));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    try {
      return Buffer.concat([decipher.update(Buffer.from(payload.ct, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new PairKeyIntegrityError();
    }
  }

  private aad(ownerId: string, renteeId: string, pair: string): Buffer {
    return Buffer.from(`${ownerId}\u0000${renteeId}\u0000${pair}`, 'utf8');
  }

  private pairFingerprint(key: Buffer): string {
    return createHash('sha256').update(key).digest('hex').slice(0, 16);
  }
}

/**
 * Dev fallback master seed. Production SHOULD set `DFAP_PAIR_MASTER_KEY`
 * (HSM-wrapped or KMS-managed); the fallback derives a deterministic dev
 * secret from process key material so a dev restart stays consistent without
 * configuring anything. Explicitly NOT a secret: it never leaves the process.
 */
export function devFallbackMasterSeed(material: string): Buffer {
  return createHash('sha256').update(`dfap-pair-master-v1\u0000${material}`).digest();
}
