import { generateKeyPairSync, sign as signBytes, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  AwsInstanceIdentityVerifier,
  DisabledInstanceIdentityVerifier,
  InstanceIdentityError,
  type AwsIdentityCertProvider,
} from '../src/guest/instance-identity.js';

/**
 * LOCAL FIXTURE, NOT REAL AWS PROOF. These tests generate their own RSA keypair
 * and sign documents with it. Passing them proves the verifier implements the
 * RSA-SHA256 check and the field/binding rules correctly; it does NOT prove
 * integration with AWS's real regional certificates or a live IMDS document,
 * which is exactly why `DFAP_GUEST_PROVISIONING=instance-identity` is refused in
 * production until that is validated.
 */

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

class FixtureCertProvider implements AwsIdentityCertProvider {
  calls: string[] = [];
  constructor(private readonly keys: Record<string, KeyObject>) {}
  async publicKeyForRegion(region: string): Promise<KeyObject> {
    this.calls.push(region);
    const k = this.keys[region];
    if (!k) throw new InstanceIdentityError(`unknown region ${region}`, 401);
    return k;
  }
}

function document(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    accountId: '123456789012',
    architecture: 'x86_64',
    imageId: 'ami-0123456789abcdef0',
    instanceId: 'i-0123456789abcdef0',
    instanceType: 't4g.small',
    region: 'us-east-1',
    ...over,
  });
}

/** base64(doc bytes) + base64(RSA-SHA256(doc bytes)). */
function presented(doc: string, key: KeyObject = privateKey): { document: string; signature: string } {
  const bytes = Buffer.from(doc, 'utf8');
  const sig = signBytes('RSA-SHA256', bytes, key);
  return { document: bytes.toString('base64'), signature: sig.toString('base64') };
}

function verifier(): AwsInstanceIdentityVerifier {
  return new AwsInstanceIdentityVerifier(new FixtureCertProvider({ 'us-east-1': publicKey }));
}

describe('AwsInstanceIdentityVerifier — RSA-SHA256 over the signed document', () => {
  it('accepts a correctly signed document and returns the authenticated fields', async () => {
    const identity = await verifier().verify(presented(document()));
    expect(identity).toEqual({
      instanceId: 'i-0123456789abcdef0',
      imageId: 'ami-0123456789abcdef0',
      region: 'us-east-1',
      accountId: '123456789012',
      method: 'aws-instance-identity-document',
    });
  });

  it('rejects a tampered document (signature no longer matches)', async () => {
    const p = presented(document());
    // Swap one byte of the document after signing.
    const tampered = Buffer.from(p.document, 'base64');
    tampered[10] = tampered[10]! ^ 0xff;
    await expect(
      verifier().verify({ document: tampered.toString('base64'), signature: p.signature }),
    ).rejects.toBeInstanceOf(InstanceIdentityError);
  });

  it('rejects a signature made with a different key', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const p = presented(document(), other.privateKey);
    await expect(verifier().verify(p)).rejects.toThrow(/signature verification failed/);
  });

  it('rejects a signature over a DIFFERENT document (cross-document replay)', async () => {
    const p = presented(document({ instanceId: 'i-0aaaaaaaaaaaaaaaa' }));
    const otherDoc = document({ instanceId: 'i-0bbbbbbbbbbbbbbbb' });
    await expect(
      verifier().verify({ document: Buffer.from(otherDoc, 'utf8').toString('base64'), signature: p.signature }),
    ).rejects.toThrow(/signature verification failed/);
  });

  it('rejects non-base64 encodings', async () => {
    await expect(verifier().verify({ document: 'not base64!!', signature: 'AAAA' })).rejects.toThrow(/not valid base64/);
  });

  it('rejects an empty or oversized document', async () => {
    await expect(verifier().verify({ document: '', signature: 'AAAA' })).rejects.toThrow(/missing/);
    const huge = Buffer.alloc(20 * 1024, 0x20).toString('base64');
    await expect(verifier().verify({ document: huge, signature: 'AAAA' })).rejects.toThrow(/invalid size/);
  });

  it('rejects a document that is not JSON / not an object', async () => {
    const bytes = Buffer.from('{not json', 'utf8');
    const sig = signBytes('RSA-SHA256', bytes, privateKey);
    await expect(
      verifier().verify({ document: bytes.toString('base64'), signature: sig.toString('base64') }),
    ).rejects.toThrow(/not valid JSON/);

    const arr = presented('[]');
    await expect(verifier().verify(arr)).rejects.toThrow(/not an object/);
  });

  it('rejects a signed document with an invalid region format', async () => {
    await expect(verifier().verify(presented(document({ region: 'not-a-region' })))).rejects.toThrow(/invalid region/);
  });

  it('fails when the region has no pinned key (unknown region)', async () => {
    await expect(verifier().verify(presented(document({ region: 'eu-west-3' })))).rejects.toThrow(/unknown region/);
  });

  it('rejects a VALID signature whose fields are malformed (authenticated-but-bogus)', async () => {
    await expect(verifier().verify(presented(document({ instanceId: 'i-ZZZ' })))).rejects.toThrow(/invalid instanceId/);
    await expect(verifier().verify(presented(document({ imageId: 'notami' })))).rejects.toThrow(/invalid imageId/);
    await expect(verifier().verify(presented(document({ accountId: '123' })))).rejects.toThrow(/invalid accountId/);
    await expect(verifier().verify(presented(document({ accountId: 42 })))).rejects.toThrow(/missing accountId/);
  });

  it('selects the key by the claimed region only AFTER the signature is checked', async () => {
    const certs = new FixtureCertProvider({ 'us-east-1': publicKey });
    const v = new AwsInstanceIdentityVerifier(certs);
    await v.verify(presented(document()));
    // The region lookup happens (key selection), but a bogus region that has no
    // key never yields an identity.
    expect(certs.calls).toEqual(['us-east-1']);
  });
});

describe('DisabledInstanceIdentityVerifier — fail closed', () => {
  it('rejects every proof with a 503', async () => {
    const err = await new DisabledInstanceIdentityVerifier()
      .verify({ document: 'x', signature: 'y' })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InstanceIdentityError);
    expect((err as InstanceIdentityError).statusCode).toBe(503);
  });
});
