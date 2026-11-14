/**
 * Instance-identity verification — the trust root for guest credential
 * provisioning (audit finding C3, milestone M8).
 *
 * WHY THIS EXISTS
 * The previous design put a control-plane-sealed credential blob in EC2
 * `userData` and expected an in-image unit to unseal it. That is unsound: any
 * guest-side unseal requires key material in the guest, and a key baked into a
 * reusable AMI is a shared secret across every instance of that AMI. There is
 * no way to make that meet "no shared key in a reusable image" and it delivers
 * a secret that a second instance could not be *proven* unentitled to.
 *
 * THE MECHANISM
 * The guest proves *which instance it is* with AWS's own signed instance
 * identity document (IMDSv2):
 *
 *   /latest/dynamic/instance-identity/document   (JSON, the signed bytes)
 *   /latest/dynamic/instance-identity/signature  (base64 RSA-SHA256 of those bytes)
 *
 * The document is signed by a per-region AWS RSA key, so it is INDEPENDENTLY
 * VERIFIABLE and PER-INSTANCE: IMDS is link-local and only ever serves the
 * instance's OWN document, so instance A cannot obtain or forge a document
 * naming instance B. Verification is a plain RSA signature check via Node's
 * `crypto` module — we never hand-roll a signature scheme.
 *
 * WHAT VERIFICATION DOES *NOT* PROVE
 * A valid document proves "I am instance X in region R, built from image I".
 * It does NOT prove that instance X is authorized for any particular session.
 * That authorization is enforced separately and server-side, by joining the
 * verified instance id to the pool/session records this control plane launched
 * (`guest/provisioning-package.ts` + the binding resolver). We deliberately do
 * NOT treat the instance role — a generic, shared principal — as proof of
 * authorization.
 *
 * PRODUCTION STATUS
 * This verifier is exercised against generated keypairs locally. It has NOT
 * been validated against AWS's real regional certificates or a live IMDS
 * document, so `DFAP_GUEST_PROVISIONING=instance-identity` is refused in
 * production (see `config.ts`) rather than shipped unverified.
 */

import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';

/** A verified, cryptographically authenticated instance identity. */
export interface VerifiedInstanceIdentity {
  /** EC2 instance id (`i-…`). */
  instanceId: string;
  /** AMI the instance booted (`ami-…`). */
  imageId: string;
  /** AWS region from the signed document. */
  region: string;
  /** AWS account id from the signed document. */
  accountId: string;
  /** The proof mechanism used. Exactly one, so callers can audit it. */
  method: 'aws-instance-identity-document';
}

/** A raw, still-untrusted identity proof presented by the guest. */
export interface PresentedInstanceIdentity {
  /** base64 of the raw `instance-identity/document` bytes exactly as signed. */
  document: string;
  /** base64 of the RSA-SHA256 detached signature over those bytes. */
  signature: string;
}

export interface InstanceIdentityVerifier {
  /**
   * Verify a presented proof and return the authenticated identity. Throws
   * `InstanceIdentityError` on ANY failure (bad encoding, bad signature,
   * missing field, unknown region). Never returns a partially-trusted result.
   */
  verify(presented: PresentedInstanceIdentity): Promise<VerifiedInstanceIdentity>;
}

export class InstanceIdentityError extends Error {
  /** HTTP status the API maps this to (401 = unproven, 403 = denied). */
  readonly statusCode: number;
  constructor(message: string, statusCode = 401) {
    super(message);
    this.name = 'InstanceIdentityError';
    this.statusCode = statusCode;
  }
}

/**
 * AWS's per-region instance-identity RSA public key. Supplied out of band
 * (bundled in the image / pinned in config) — a verifier must NEVER fetch the
 * key from an attacker-influenceable location on the request path.
 */
export interface AwsIdentityCertProvider {
  /** The RSA public key AWS signs region `region`'s documents with. */
  publicKeyForRegion(region: string): Promise<KeyObject>;
}

const MAX_DOCUMENT_BYTES = 16 * 1024;

const INSTANCE_ID_RE = /^i-[0-9a-f]{8,17}$/;
const IMAGE_ID_RE = /^ami-[0-9a-f]{8,17}$/;
const REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const ACCOUNT_RE = /^\d{12}$/;

function decodeBase64(name: string, value: string): Buffer {
  if (typeof value !== 'string' || value === '') {
    throw new InstanceIdentityError(`instance identity ${name} is missing`);
  }
  // Reject anything that is not strict base64 (Buffer is lenient by default).
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new InstanceIdentityError(`instance identity ${name} is not valid base64`);
  }
  return Buffer.from(value, 'base64');
}

function requireField(doc: Record<string, unknown>, name: string): string {
  const v = doc[name];
  if (typeof v !== 'string' || v === '') {
    throw new InstanceIdentityError(`instance identity document missing ${name}`);
  }
  return v;
}

/**
 * Real verifier: RSA-SHA256 over the exact signed bytes, then structural
 * validation of the (now authenticated) fields. Field validation happens
 * AFTER signature verification so an attacker cannot use malformed fields to
 * steer key selection: the region used to pick the key is only trusted once
 * the signature under that region's key has verified.
 */
export class AwsInstanceIdentityVerifier implements InstanceIdentityVerifier {
  constructor(private readonly certs: AwsIdentityCertProvider) {}

  async verify(presented: PresentedInstanceIdentity): Promise<VerifiedInstanceIdentity> {
    const docBytes = decodeBase64('document', presented.document);
    if (docBytes.length === 0 || docBytes.length > MAX_DOCUMENT_BYTES) {
      throw new InstanceIdentityError('instance identity document has an invalid size');
    }
    const sigBytes = decodeBase64('signature', presented.signature);

    let parsed: unknown;
    try {
      parsed = JSON.parse(docBytes.toString('utf8'));
    } catch {
      throw new InstanceIdentityError('instance identity document is not valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new InstanceIdentityError('instance identity document is not an object');
    }
    const doc = parsed as Record<string, unknown>;

    // The region selects the key. A wrong region yields a key that cannot
    // verify the signature, so this is safe to do before full validation.
    const region = requireField(doc, 'region');
    if (!REGION_RE.test(region)) {
      throw new InstanceIdentityError('instance identity document has an invalid region');
    }

    const publicKey = await this.certs.publicKeyForRegion(region);
    let ok: boolean;
    try {
      ok = verifySignature('RSA-SHA256', docBytes, publicKey, sigBytes);
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new InstanceIdentityError('instance identity signature verification failed');
    }

    // Signature is valid: the fields below are now authenticated by AWS.
    const instanceId = requireField(doc, 'instanceId');
    const imageId = requireField(doc, 'imageId');
    const accountId = requireField(doc, 'accountId');
    if (!INSTANCE_ID_RE.test(instanceId)) throw new InstanceIdentityError('instance identity has an invalid instanceId');
    if (!IMAGE_ID_RE.test(imageId)) throw new InstanceIdentityError('instance identity has an invalid imageId');
    if (!ACCOUNT_RE.test(accountId)) throw new InstanceIdentityError('instance identity has an invalid accountId');

    return { instanceId, imageId, region, accountId, method: 'aws-instance-identity-document' };
  }
}

/**
 * Fail-closed verifier. Composed whenever guest provisioning is not an
 * explicitly enabled, materials-backed mode: every proof is rejected with a
 * 503 so a misconfigured deployment serves no guest credentials rather than
 * trusting an unverified document.
 */
export class DisabledInstanceIdentityVerifier implements InstanceIdentityVerifier {
  async verify(_presented: PresentedInstanceIdentity): Promise<VerifiedInstanceIdentity> {
    throw new InstanceIdentityError('guest provisioning is disabled', 503);
  }
}
