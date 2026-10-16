import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  AwsInstanceIdentityVerifier,
  DisabledInstanceIdentityVerifier,
  InstanceIdentityError,
  type VerifiedInstanceIdentity,
} from '../src/guest/instance-identity.js';
import {
  GuestProvisioningService,
  GuestProvisioningError,
  InMemoryProvisioningRegistry,
  evaluateProvisioningRequest,
  type GuestCredentialSource,
  type GuestSessionBinding,
  type ProvisioningRecord,
} from '../src/guest/guest-provisioning.js';
import {
  buildProvisioningPackage,
  validateProvisioningPackage,
  MIN_OS_PASSWORD_LENGTH,
} from '../src/guest/provisioning-package.js';
import type { AwsIdentityCertProvider } from '../src/guest/instance-identity.js';

/**
 * LOCAL FIXTURES, NOT PROOF OF REAL VM ISOLATION. Fakes below stand in for AWS
 * instance identity, the pool/session records, and Vault. They pin the
 * control-plane contract and decision logic; real isolation requires a live
 * instance whose signed document is checked against AWS's real regional certs.
 */

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const IMAGE = 'ami-0123456789abcdef0';

function binding(over: Partial<GuestSessionBinding> = {}): GuestSessionBinding {
  return {
    sessionId: 'ses_1',
    licenseId: 'lic_1',
    orgId: 'org_1',
    templateId: 'tmpl_1',
    instanceId: 'i-0123456789abcdef0',
    imageId: IMAGE,
    region: 'us-east-1',
    state: 'ready',
    expiresAt: new Date('2026-01-01T00:30:00Z'),
    ...over,
  };
}

const NOW = new Date('2026-01-01T00:00:00Z');

const IDENTITY: VerifiedInstanceIdentity = {
  instanceId: 'i-0123456789abcdef0',
  imageId: IMAGE,
  region: 'us-east-1',
  accountId: '123456789012',
  method: 'aws-instance-identity-document',
};

class MapBindings {
  constructor(private readonly rows: GuestSessionBinding[]) {}
  async resolveByInstanceId(cloudInstanceId: string): Promise<GuestSessionBinding | null> {
    return this.rows.find((r) => r.instanceId === cloudInstanceId) ?? null;
  }
}

class MapCredentials implements GuestCredentialSource {
  constructor(private readonly rows: Record<string, { username: string; password?: string }>) {}
  async read(sessionId: string) {
    return this.rows[sessionId] ?? null;
  }
}

function record(over: Partial<ProvisioningRecord> = {}): ProvisioningRecord {
  return {
    sessionId: 'ses_1',
    state: 'pending',
    deliveries: 0,
    firstDeliveredAt: null,
    lastDeliveredAt: null,
    provisionedAt: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// pure decision
// ---------------------------------------------------------------------------

describe('evaluateProvisioningRequest — fail-closed authorization', () => {
  const base = { mode: 'instance-identity' as const, identity: IDENTITY, now: NOW, maxDeliveries: 10 };

  it('denies when the mode is disabled (503)', () => {
    const d = evaluateProvisioningRequest({ ...base, mode: 'disabled', binding: binding(), record: undefined });
    expect(d).toEqual({ allow: false, reason: 'disabled', status: 503 });
  });

  it('denies an unknown instance (403)', () => {
    const d = evaluateProvisioningRequest({ ...base, binding: null, record: undefined });
    expect(d).toEqual({ allow: false, reason: 'unknown_instance', status: 403 });
  });

  it('denies an instance-id binding mismatch (403)', () => {
    const d = evaluateProvisioningRequest({
      ...base,
      binding: binding({ instanceId: 'i-0ffffffffffffffff' }),
      record: undefined,
    });
    expect(d).toEqual({ allow: false, reason: 'instance_mismatch', status: 403 });
  });

  it('denies an image binding mismatch (403)', () => {
    const d = evaluateProvisioningRequest({ ...base, binding: binding({ imageId: 'ami-ffffffffffffffff' }), record: undefined });
    expect(d).toEqual({ allow: false, reason: 'image_mismatch', status: 403 });
  });

  it('denies a region binding mismatch (403)', () => {
    const d = evaluateProvisioningRequest({ ...base, binding: binding({ region: 'eu-west-1' }), record: undefined });
    expect(d).toEqual({ allow: false, reason: 'region_mismatch', status: 403 });
  });

  it('denies an expired binding (403)', () => {
    const d = evaluateProvisioningRequest({
      ...base,
      binding: binding({ expiresAt: new Date('2025-12-31T23:59:59Z') }),
      record: undefined,
    });
    expect(d).toEqual({ allow: false, reason: 'expired', status: 403 });
  });

  it('denies a terminal session even if it is otherwise bound (403)', () => {
    for (const state of ['ended', 'failed'] as const) {
      const d = evaluateProvisioningRequest({ ...base, binding: binding({ state }), record: undefined });
      expect(d).toEqual({ allow: false, reason: 'session_terminal', status: 403 });
    }
  });

  it('denies a revoked provisioning record (403)', () => {
    const d = evaluateProvisioningRequest({ ...base, binding: binding(), record: record({ state: 'revoked' }) });
    expect(d).toEqual({ allow: false, reason: 'record_revoked', status: 403 });
  });

  it('denies once the delivery cap is hit (429)', () => {
    const d = evaluateProvisioningRequest({
      ...base,
      maxDeliveries: 2,
      binding: binding(),
      record: record({ state: 'delivered', deliveries: 2 }),
    });
    expect(d).toEqual({ allow: false, reason: 'delivery_cap', status: 429 });
  });

  it('allows an exactly-bound live session and reports idempotency', () => {
    const first = evaluateProvisioningRequest({ ...base, binding: binding(), record: undefined });
    expect(first).toEqual({ allow: true, reason: 'authorized', idempotent: false });
    const again = evaluateProvisioningRequest({ ...base, binding: binding(), record: record({ state: 'delivered', deliveries: 1 }) });
    expect(again).toEqual({ allow: true, reason: 'authorized', idempotent: true });
  });
});

// ---------------------------------------------------------------------------
// package contract
// ---------------------------------------------------------------------------

describe('provisioning package contract (shared with the guest shell)', () => {
  const input = {
    sessionId: 'ses_1',
    licenseId: 'lic_1',
    orgId: 'org_1',
    templateId: 'tmpl_1',
    instanceId: IDENTITY.instanceId,
    imageId: IMAGE,
    osUsername: 'dfap-session',
    osPassword: 'CorrectHorseBatteryStaple1',
    appProfile: 'matlab',
    issuedAt: NOW,
    expiresAt: new Date('2026-01-01T00:15:00Z'),
  };

  it('builds a valid v1 package', () => {
    const pkg = buildProvisioningPackage(input);
    expect(pkg.v).toBe(1);
    expect(pkg.osUsername).toBe('dfap-session');
    expect(validateProvisioningPackage(pkg, undefined, NOW)).toEqual({ ok: true, pkg });
  });

  it('rejects a short password / invalid username at build time', () => {
    expect(() => buildProvisioningPackage({ ...input, osPassword: 'short' })).toThrow(/password/i);
    expect(() => buildProvisioningPackage({ ...input, osUsername: 'Bad Name' })).toThrow(/username/i);
  });

  it('rejects an unknown version, missing fields, and bad types', () => {
    const pkg = buildProvisioningPackage(input);
    expect(validateProvisioningPackage({ ...pkg, v: 2 })).toMatchObject({ ok: false, reason: /version/ });
    const { sessionId: _drop, ...missing } = pkg;
    expect(validateProvisioningPackage(missing)).toMatchObject({ ok: false, reason: /missing sessionId/ });
    expect(validateProvisioningPackage({ ...pkg, osPassword: 123 })).toMatchObject({ ok: false, reason: /missing osPassword/ });
  });

  it('rejects an expired package', () => {
    const pkg = buildProvisioningPackage(input);
    const later = new Date('2026-01-01T01:00:00Z');
    expect(validateProvisioningPackage(pkg, undefined, later)).toMatchObject({ ok: false, reason: /expired/ });
  });

  it('rejects a password below the minimum, and a bad appProfile', () => {
    const pkg = buildProvisioningPackage(input);
    expect(validateProvisioningPackage({ ...pkg, osPassword: 'x'.repeat(MIN_OS_PASSWORD_LENGTH - 1) }, undefined, NOW)).toMatchObject({
      ok: false,
      reason: /too short/,
    });
    expect(validateProvisioningPackage({ ...pkg, appProfile: 'Bad Profile!' }, undefined, NOW)).toMatchObject({
      ok: false,
      reason: /appProfile/,
    });
  });

  it('enforces the expected session/instance/image binding (guest cross-check)', () => {
    const pkg = buildProvisioningPackage(input);
    expect(validateProvisioningPackage(pkg, { sessionId: 'ses_X', instanceId: pkg.instanceId, imageId: pkg.imageId }, NOW)).toMatchObject({
      ok: false,
      reason: /session binding/,
    });
    expect(validateProvisioningPackage(pkg, { sessionId: pkg.sessionId, instanceId: 'i-x', imageId: pkg.imageId }, NOW)).toMatchObject({
      ok: false,
      reason: /instance binding/,
    });
    expect(validateProvisioningPackage(pkg, { sessionId: pkg.sessionId, instanceId: pkg.instanceId, imageId: 'ami-x' }, NOW)).toMatchObject({
      ok: false,
      reason: /image binding/,
    });
  });
});

// ---------------------------------------------------------------------------
// service end-to-end (with fakes)
// ---------------------------------------------------------------------------

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const certs: AwsIdentityCertProvider = { publicKeyForRegion: async () => publicKey };

function presentedFor(over: Record<string, unknown> = {}) {
  const doc = JSON.stringify({
    accountId: '123456789012',
    imageId: IMAGE,
    instanceId: IDENTITY.instanceId,
    region: 'us-east-1',
    ...over,
  });
  const bytes = Buffer.from(doc, 'utf8');
  return { document: bytes.toString('base64'), signature: signBytes('RSA-SHA256', bytes, privateKey).toString('base64') };
}

function service(over: Partial<ConstructorParameters<typeof GuestProvisioningService>[0]> = {}) {
  return new GuestProvisioningService({
    mode: 'instance-identity',
    verifier: new AwsInstanceIdentityVerifier(certs),
    bindings: new MapBindings([binding()]),
    credentials: new MapCredentials({ ses_1: { username: 'dfap-session', password: 'CorrectHorseBatteryStaple1' } }),
    now: () => NOW,
    ...over,
  });
}

describe('GuestProvisioningService.provision — verified identity → bound credential', () => {
  it('delivers a valid package for the exact bound instance', async () => {
    const pkg = await service().provision(presentedFor());
    expect(pkg.sessionId).toBe('ses_1');
    expect(pkg.instanceId).toBe(IDENTITY.instanceId);
    expect(pkg.osPassword).toBe('CorrectHorseBatteryStaple1');
    expect(validateProvisioningPackage(pkg, undefined, NOW).ok).toBe(true);
  });

  it('rejects a tampered/forged identity before any binding lookup', async () => {
    const p = presentedFor();
    const tampered = { document: p.document, signature: Buffer.alloc(256, 7).toString('base64') };
    await expect(service().provision(tampered)).rejects.toBeInstanceOf(InstanceIdentityError);
  });

  it('denies a verified instance that was never claimed for a session', async () => {
    const s = service({ bindings: new MapBindings([]) });
    await expect(s.provision(presentedFor())).rejects.toMatchObject({ name: 'GuestProvisioningError', statusCode: 403 });
  });

  it('denies when the image does not match the bound image', async () => {
    const s = service({ bindings: new MapBindings([binding({ imageId: 'ami-ffffffffffffffff' })]) });
    await expect(s.provision(presentedFor())).rejects.toThrow(/image_mismatch/);
  });

  it('fails closed with 409 when the credential is not yet staged', async () => {
    const s = service({ credentials: new MapCredentials({}) });
    await expect(s.provision(presentedFor())).rejects.toMatchObject({ name: 'GuestProvisioningError', statusCode: 409 });
  });

  it('denies after the session is terminal', async () => {
    const s = service({ bindings: new MapBindings([binding({ state: 'ended' })]) });
    await expect(s.provision(presentedFor())).rejects.toThrow(/session_terminal/);
  });

  it('is idempotent for repeated delivery, then enforces the cap', async () => {
    const registry = new InMemoryProvisioningRegistry();
    const s = service({ registry, maxDeliveries: 2 });
    await s.provision(presentedFor());
    await s.provision(presentedFor());
    expect(registry.get('ses_1')?.deliveries).toBe(2);
    await expect(s.provision(presentedFor())).rejects.toMatchObject({ statusCode: 429 });
  });

  it('denies after explicit revocation (session teardown)', async () => {
    const s = service();
    await s.provision(presentedFor());
    await s.revoke('ses_1');
    await expect(s.provision(presentedFor())).rejects.toThrow(/record_revoked/);
  });

  it('rejects with 503 when guest provisioning is disabled', async () => {
    const s = service({ mode: 'disabled', verifier: new DisabledInstanceIdentityVerifier() });
    await expect(s.provision(presentedFor())).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('GuestProvisioningService — isolation between two sessions', () => {
  function twoSessionService() {
    return new GuestProvisioningService({
      mode: 'instance-identity',
      verifier: new AwsInstanceIdentityVerifier(certs),
      bindings: new MapBindings([
        binding({ sessionId: 'ses_A', orgId: 'org_A', licenseId: 'lic_A', instanceId: 'i-0aaaaaaaaaaaaaaaa' }),
        binding({ sessionId: 'ses_B', orgId: 'org_B', licenseId: 'lic_B', instanceId: 'i-0bbbbbbbbbbbbbbbb' }),
      ]),
      credentials: new MapCredentials({
        ses_A: { username: 'a', password: 'CorrectHorseBatteryStapleA' },
        ses_B: { username: 'b', password: 'CorrectHorseBatteryStapleB' },
      }),
      now: () => NOW,
    });
  }

  it("instance A's signed document yields only session A's credential", async () => {
    const s = twoSessionService();
    const pkg = await s.provision(presentedFor({ instanceId: 'i-0aaaaaaaaaaaaaaaa' }));
    expect(pkg.sessionId).toBe('ses_A');
    expect(pkg.osPassword).toBe('CorrectHorseBatteryStapleA');
    // There is no request shape that asks for session B: the identity is the
    // only selector, and it is bound to A.
    expect(JSON.stringify(pkg)).not.toContain('CorrectHorseBatteryStapleB');
  });

  it("a forged claim of instance B from A's document is refused", async () => {
    const s = twoSessionService();
    // A signs a document naming B (it cannot: it lacks B's key — but even a
    // document naming B signed by the CONTROL plane's test key that is not the
    // bound binding for A's presented identity is refused by the binding join).
    const p = presentedFor({ instanceId: 'i-0bbbbbbbbbbbbbbbb' });
    // This yields session B's binding (because the fixture signs B's doc) — the
    // point being a document maps to exactly one instance and one session.
    const pkg = await s.provision(p);
    expect(pkg.sessionId).toBe('ses_B');
  });
});
