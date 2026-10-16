/**
 * Pre-boot credential injection — the spec's offline injection step:
 *
 *   "Before the VM is spun up, the orchestrator gets access to the VM's disk
 *    file directly and writes the trust certificate into the authorized
 *    logins section of the OS itself. After all this the orchestrator gives
 *    the hypervisor the signal to boot the VM."
 *
 * Realization seam: the pool manager calls `prepare()` with the hardened
 * launch spec + the credential BEFORE `RunInstances`, and the returned
 * `userData` rides on the launch spec so the login material is on the VM's
 * disk from first boot — the RDP service never sees a window where a NULL
 * password must be set over the network (which is the bootstrap hole the
 * spec closes).
 *
 * Production notes (Phase-1 wiring, same port):
 *  - AWS: the golden image ships a `dfap-preboot.service` unit (injected by
 *    the Packer offline-harden stage) that unseals the blob below, materializes
 *    the OS login locally (Linux: authorized_keys/ssh cert; Windows: offline
 *    SAM provisioning performed by the offline-harden worker), deletes the
 *    blob and journal, and only then enables the RDP listener. The wrap key
 *    below becomes an image-baked key recorded per build in
 *    `workspace_images`, so a leaked blob is useless against any other image.
 *  - The blob contains NO plaintext credential and NO key: it is sealed to
 *    (sessionId, imageId) with the guest-image wrap key.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import type { LaunchSpec } from './provider.js';

export interface PreBootCredential {
  username: string;
  password?: string;
  privateKey?: string;
}

export interface PreBootInjection {
  /**
   * bytes to attach to the launch spec (`LaunchSpec.userData`), or undefined
   * when the injector has nothing to add.
   */
  userData?: string;
  method: 'sealed-blob' | 'cloud-init' | 'none';
}

export interface PreBootInjector {
  prepare(spec: LaunchSpec, credential: PreBootCredential): Promise<PreBootInjection>;
}

/** Marker written ahead of the sealed JSON payload. */
export const PREBOOT_MARKER = 'X-DFAP-PREBOOT-V1:';

export class OfflineImageInjector implements PreBootInjector {
  /** sessionId → sealed blob (audit/test view; never the unsealed credential). */
  private readonly injected = new Map<string, string>();

  /**
   * @param imageWrapKey 32-byte-per-image symmetric key the golden image's
   * preboot unit holds (dev: derived once from the platform master seed;
   * production: baked at Packer build time and pinned per AMI).
   */
  constructor(private readonly imageWrapKey: Buffer) {
    if (!Buffer.isBuffer(imageWrapKey) || imageWrapKey.length < 32) {
      throw new Error('OfflineImageInjector requires a ≥32-byte image wrap key');
    }
  }

  async prepare(spec: LaunchSpec, credential: PreBootCredential): Promise<PreBootInjection> {
    if (!spec.sessionId) return { method: 'none' };
    const envelope = {
      sessionId: spec.sessionId,
      imageId: spec.imageId,
      username: credential.username,
      // Field names mirror what the guest unit will materialize; the whole
      // envelope below is sealed, so plaintext only ever exists inside the
      // ciphertext on disk.
      ...(credential.password !== undefined ? { password: credential.password } : {}),
      ...(credential.privateKey !== undefined ? { private_key: credential.privateKey } : {}),
    };
    const plaintext = JSON.stringify(envelope);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.imageWrapKey.subarray(0, 32), iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(`${spec.sessionId}\u0000${spec.imageId}`, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const blob = JSON.stringify({
      sessionId: spec.sessionId,
      imageId: spec.imageId,
      alg: 'AES-256-GCM-IMAGEKEY',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ct.toString('base64'),
    });
    const userData = `${PREBOOT_MARKER}${blob}`;
    this.injected.set(spec.sessionId, userData);
    return { method: 'sealed-blob', userData };
  }

  /** Audit/test view: session ids for whom a pre-boot blob was written. */
  injectedSessions(): string[] {
    return [...this.injected.keys()];
  }

  /** Unseal helper mirroring the production guest unit (tests/debug only). */
  static unseal(
    imageWrapKey: Buffer,
    imageId: string,
    userData: string,
  ): { sessionId: string; username: string; password?: string; private_key?: string } {
    if (!userData.startsWith(PREBOOT_MARKER)) throw new Error('userData is not a dfap pre-boot blob');
    const parsed = JSON.parse(userData.slice(PREBOOT_MARKER.length)) as {
      sessionId: string;
      imageId: string;
      alg: string;
      iv: string;
      tag: string;
      ct: string;
    };
    if (parsed.alg !== 'AES-256-GCM-IMAGEKEY') throw new Error(`unsupported preboot alg ${parsed.alg}`);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      imageWrapKey.subarray(0, 32),
      Buffer.from(parsed.iv, 'base64'),
      { authTagLength: 16 },
    );
    // Bind to the image the CALLER says it is (its own AMI id), not the one the
    // blob claims — so a blob copied to another image fails the GCM tag.
    decipher.setAAD(Buffer.from(`${parsed.sessionId}\u0000${imageId}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    const json = Buffer.concat([decipher.update(Buffer.from(parsed.ct, 'base64')), decipher.final()]).toString('utf8');
    return JSON.parse(json) as { sessionId: string; username: string; password?: string; private_key?: string };
  }
}

/**
 * Explicit no-op for deployments where pre-boot injection is not wired (e.g.
 * warm instances already booted, or vault-handshake-only Phase-0). Being an
 * explicit type — rather than an `undefined` in pool deps — keeps call sites
 * readable and grep-able.
 */
export class NoPreBootInjector implements PreBootInjector {
  async prepare(_spec: LaunchSpec, _credential: PreBootCredential): Promise<PreBootInjection> {
    return { method: 'none' };
  }
}

/** Derived dev image wrap key (see module comment for the production story). */
export function deriveImageWrapKey(masterSeed: Buffer): Buffer {
  return createHash('sha256')
    .update(`dfap-guest-image-key-v1\u0000${masterSeed.toString('hex')}`)
    .digest();
}
