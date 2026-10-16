/**
 * AWS instance-identity public-key provider.
 *
 * Phase-0/CI supplies a single regional public key (the deployment is
 * single-region). The key is NEVER fetched from an attacker-influenceable
 * location on the request path: it is bundled/pinned at deploy time. A
 * multi-region deployment swaps in a `region → key` map behind the same
 * `AwsIdentityCertProvider` interface.
 *
 * Validation is deliberate: only an RSA public key is accepted, so a
 * mis-supplied symmetric value (or a typo that yields a non-key) fails boot
 * rather than silently verifying nothing.
 */

import { createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { AwsIdentityCertProvider } from './instance-identity.js';

export class StaticAwsCertProvider implements AwsIdentityCertProvider {
  private readonly key: KeyObject;

  constructor(material: { file?: string; pem?: string }) {
    const pem = material.pem ?? (material.file ? readFileSync(material.file, 'utf8') : '');
    if (!pem.trim()) {
      throw new Error('AWS instance-identity cert material is empty');
    }
    this.key = createPublicKey(pem);
    if (this.key.asymmetricKeyType !== 'rsa') {
      throw new Error('AWS instance-identity key must be an RSA public key');
    }
  }

  async publicKeyForRegion(): Promise<KeyObject> {
    return this.key;
  }
}
