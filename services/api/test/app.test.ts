import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { buildApp, type ApiServices } from '../src/app.js';
import type { SessionRecord } from '../src/ports.js';
import { generateEphemeralHsm } from '../src/crypto/hsm-rsa.js';
import { InMemoryMarketplaceStore } from '../src/marketplace/license-store.js';
import { TwoThreadOrchestrator } from '../src/orchestrator/two-thread-orchestrator.js';
import { DevHeaderAuthenticator, FailClosedAuthenticator, type Principal } from '../src/auth/authenticator.js';
import { GuestProvisioningService, type GuestSessionBinding } from '../src/guest/guest-provisioning.js';
import { AwsInstanceIdentityVerifier } from '../src/guest/instance-identity.js';

const DEV_ORIGIN = 'http://localhost:5173';
const CORS = { corsAllowedOrigins: [DEV_ORIGIN] };

function mockServices(
  principal: Principal = { userId: 'usr_test', orgId: 'org_test', role: 'member' },
): ApiServices {
  const sessions = new Map<string, SessionRecord>();
  const hsm = generateEphemeralHsm();
  const marketplace = new InMemoryMarketplaceStore();

  const createSessionFn = async (_principal: any, input: any) => {
    const id = 'ses_123';
    const record: SessionRecord = {
      id,
      orgId: 'org_test',
      userId: 'usr_test',
      templateId: input.templateId,
      instanceId: 'inst_1',
      licenseId: null,
      state: 'ready',
      requestedAt: new Date(),
      readyAt: new Date(),
      firstPixelAt: null,
      connectedAt: null,
      disconnectedAt: null,
      endedAt: null,
      endReason: null,
      billableSeconds: null,
      vaultCredPath: null,
      clientIp: null,
      clientUa: null,
    };
    sessions.set(id, record);
    return {
      sessionId: id,
      token: 'DFAP1.tok_123',
      brokerUrl: 'ws://localhost:8080/tunnel',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  };

  const orchestrator = new TwoThreadOrchestrator({
    hsm,
    marketplace,
    createSession: createSessionFn,
  });

  return {
    authenticator: {
      authenticate: async () => principal,
    },
    listTemplates: async () => [
      { id: 'tmpl_linux', name: 'Linux DevBox', os: 'linux', recording: false },
    ],
    createSession: createSessionFn,
    endSession: async (sid, reason) => {
      const existing = sessions.get(sid);
      if (existing) {
        existing.state = 'ended';
        existing.endReason = reason;
      }
      return {
        sessionId: sid,
        state: 'ended',
        endReason: reason,
        alreadyTerminal: false,
        endedAt: new Date(),
        billableSeconds: 42,
      };
    },
    getSession: async (sid) => sessions.get(sid) ?? null,
    handleWebhook: async () => ({
      received: true,
      duplicate: false,
      type: 'payment_intent.succeeded',
    }),
    marketplace,
    orchestrator,
    hsm,
  };
}

describe('API routes (Fastify app)', () => {
  it('serves /healthz with and without /api prefix', async () => {
    const app = buildApp(mockServices());
    const r1 = await app.inject({ method: 'GET', url: '/healthz' });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ status: 'ok' });

    const r2 = await app.inject({ method: 'GET', url: '/api/healthz' });
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toEqual({ status: 'ok' });
  });

  it('lists templates via GET /templates and GET /api/templates', async () => {
    const app = buildApp(mockServices());
    const res = await app.inject({ method: 'GET', url: '/api/templates' });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('tmpl_linux');
  });

  it('creates, retrieves, and deletes sessions via /api routes', async () => {
    const app = buildApp(mockServices());

    // 1. Create session
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { templateId: 'tmpl_linux' },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.sessionId).toBe('ses_123');
    expect(created.token).toBe('DFAP1.tok_123');

    // 2. Get session
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/sessions/${created.sessionId}`,
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().id).toBe('ses_123');
    expect(getRes.json().state).toBe('ready');

    // 3. Delete session (end session)
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${created.sessionId}`,
    });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json().sessionId).toBe('ses_123');
  });

  it('supports Layer 1 Marketplace and Layer 2 HSM RSA-4096 listing', async () => {
    const app = buildApp(mockServices());

    // 1. Owner lists license with plaintext credentials
    const createLicRes = await app.inject({
      method: 'POST',
      url: '/api/marketplace/licenses',
      payload: {
        softwareName: 'MATLAB R2024b',
        version: 'R2024b',
        category: 'engineering',
        description: 'Matrix computations and simulations',
        os: 'windows',
        hourlyRateUsd: 5.0,
        credentials: {
          username: 'matlab_owner',
          password: 'Secret_Password_123!',
        },
      },
    });

    expect(createLicRes.statusCode).toBe(201);
    const createdLic = createLicRes.json();
    expect(createdLic.softwareName).toBe('MATLAB R2024b');
    expect(createdLic.hsmKeyFingerprint).toMatch(/^[0-9a-f]{32}$/);

    // 2. Rentee discovers listed license
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/marketplace/licenses',
    });
    expect(listRes.statusCode).toBe(200);
    const licenses = listRes.json();
    expect(licenses).toHaveLength(1);
    expect(licenses[0].softwareName).toBe('MATLAB R2024b');
    // Ensure plaintext credentials never leaked in public listing
    expect(licenses[0].credentials).toBeUndefined();

    // 3. Rentee rents license triggering Layer 3 Two-Thread Orchestrator
    const rentRes = await app.inject({
      method: 'POST',
      url: '/api/marketplace/rent',
      payload: {
        licenseId: createdLic.id,
        hoursRequested: 2,
      },
    });

    expect(rentRes.statusCode).toBe(201);
    const rentResult = rentRes.json();
    expect(rentResult.sessionId).toBe('ses_123');
    expect(rentResult.token).toBe('DFAP1.tok_123');
    expect(rentResult.license.totalChargedUsd).toBe(10.0);
    expect(rentResult.telemetry).toBeDefined();
    expect(typeof rentResult.telemetry.thread1VmSpoolingMs).toBe('number');
    expect(typeof rentResult.telemetry.thread2CredentialRetrievalMs).toBe('number');
  });

  it('supports CORS preflight OPTIONS requests from an approved origin', async () => {
    const app = buildApp(mockServices(), CORS);
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/sessions',
      headers: {
        Origin: DEV_ORIGIN,
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(DEV_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    // The role header is never advertised or trusted (audit C4).
    expect(String(res.headers['access-control-allow-headers'])).not.toMatch(/x-dfap-role/i);
  });

  it('never reflects an unapproved browser origin', async () => {
    const app = buildApp(mockServices(), CORS);
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/sessions',
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('denies all browser origins when no allowlist is configured (default)', async () => {
    const app = buildApp(mockServices());
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/sessions',
      headers: { Origin: DEV_ORIGIN },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects unauthenticated access to the marketplace catalog (401)', async () => {
    const services = mockServices();
    services.authenticator = new FailClosedAuthenticator();
    const app = buildApp(services, CORS);
    const res = await app.inject({ method: 'GET', url: '/api/marketplace/licenses' });
    expect(res.statusCode).toBe(401);
  });

  it('ignores a forged x-dfap-role header (privilege is server-derived)', async () => {
    // The resolver reports `member`; the request lies with x-dfap-role: admin.
    const services = mockServices();
    services.authenticator = new DevHeaderAuthenticator(async () => 'member');
    const app = buildApp(services, CORS);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'x-dfap-user': 'usr_test', 'x-dfap-org': 'org_test', 'x-dfap-role': 'owner' },
      payload: { templateId: 'tmpl_linux' },
    });
    expect(createRes.statusCode).toBe(201);

    // `reason: 'admin'` is reserved for admins/owners; the forged header must
    // not unlock it, so the reason is downgraded to 'user'.
    const endRes = await app.inject({
      method: 'POST',
      url: `/api/sessions/${createRes.json().sessionId}/end`,
      headers: { 'x-dfap-user': 'usr_test', 'x-dfap-org': 'org_test', 'x-dfap-role': 'admin' },
      payload: { reason: 'admin' },
    });
    expect(endRes.statusCode).toBe(200);
    expect(endRes.json().endReason).toBe('user');
  });

  it('forbids cross-tenant session access (403)', async () => {
    const services = mockServices();
    const app = buildApp(services, CORS);
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { templateId: 'tmpl_linux' },
    });
    const sid = created.json().sessionId;

    // Same session, principal from another tenant.
    services.authenticator = {
      authenticate: async () => ({ userId: 'usr_b', orgId: 'org_b', role: 'member' }),
    };
    const read = await app.inject({ method: 'GET', url: `/api/sessions/${sid}` });
    expect(read.statusCode).toBe(403);

    const end = await app.inject({ method: 'DELETE', url: `/api/sessions/${sid}` });
    expect(end.statusCode).toBe(403);
  });

  it('forbids releasing a license owned by another user, even as an admin', async () => {
    const services = mockServices({ userId: 'usr_attacker', orgId: 'org_x', role: 'admin' });
    const lic = await services.marketplace!.create('usr_owner', {
      softwareName: 'SomeoneElses',
      version: '1',
      category: 'engineering',
      description: '',
      os: 'linux',
      hourlyRateUsd: 1,
      ownerName: 'Owner',
      encryptedCredentials: services.hsm!.encrypt(JSON.stringify({ username: 'u' })),
    });
    await services.marketplace!.markRented(lic.id, 'usr_renter');

    const app = buildApp(services, CORS);
    const res = await app.inject({
      method: 'POST',
      url: `/api/marketplace/licenses/${lic.id}/release`,
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets the owner release their own license', async () => {
    const services = mockServices({ userId: 'usr_owner', orgId: 'org_x', role: 'owner' });
    const lic = await services.marketplace!.create('usr_owner', {
      softwareName: 'Mine',
      version: '1',
      category: 'engineering',
      description: '',
      os: 'linux',
      hourlyRateUsd: 1,
      ownerName: 'Owner',
      encryptedCredentials: services.hsm!.encrypt(JSON.stringify({ username: 'u' })),
    });
    await services.marketplace!.markRented(lic.id, 'usr_renter');

    const app = buildApp(services, CORS);
    const res = await app.inject({
      method: 'POST',
      url: `/api/marketplace/licenses/${lic.id}/release`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('available');
  });

  // -------------------------------------------------------------------------
  // Guest credential provisioning endpoint (audit C3 / M8). LOCAL FIXTURES:
  // the RSA keypair and bindings below stand in for AWS and the DB.
  // -------------------------------------------------------------------------
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const GIMAGE = 'ami-0123456789abcdef0';
  const GINSTANCE = 'i-0123456789abcdef0';
  const GNOW = new Date('2026-01-01T00:00:00Z');

  function presentedFor(over: Record<string, unknown> = {}) {
    const doc = JSON.stringify({
      accountId: '123456789012',
      imageId: GIMAGE,
      instanceId: GINSTANCE,
      region: 'us-east-1',
      ...over,
    });
    const bytes = Buffer.from(doc, 'utf8');
    return { document: bytes.toString('base64'), signature: signBytes('RSA-SHA256', bytes, privateKey).toString('base64') };
  }

  function guestService(over: { binding?: GuestSessionBinding | null } = {}): GuestProvisioningService {
    const binding: GuestSessionBinding = over.binding === undefined
      ? {
          sessionId: 'ses_g',
          licenseId: 'lic_g',
          orgId: 'org_g',
          templateId: 'tmpl_g',
          instanceId: GINSTANCE,
          imageId: GIMAGE,
          region: 'us-east-1',
          state: 'ready',
          expiresAt: new Date('2026-01-01T00:30:00Z'),
        }
      : (over.binding as GuestSessionBinding);
    return new GuestProvisioningService({
      mode: 'instance-identity',
      verifier: new AwsInstanceIdentityVerifier({ publicKeyForRegion: async () => publicKey }),
      bindings: { resolveByInstanceId: async () => binding },
      credentials: { read: async (sid: string) => (sid === 'ses_g' ? { username: 'dfap-session', password: 'CorrectHorseBatteryStaple1' } : null) },
      now: () => GNOW,
    });
  }

  it('guest provisioning fails closed (503) when the service is not composed', async () => {
    const app = buildApp(mockServices());
    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/guest/provision',
      payload: { document: 'x', signature: 'y' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('delivers a provisioning package to a verified, bound instance', async () => {
    const services = mockServices();
    services.guestProvisioning = guestService();
    const app = buildApp(services);
    const res = await app.inject({ method: 'POST', url: '/api/internal/guest/provision', payload: presentedFor() });
    expect(res.statusCode).toBe(200);
    const pkg = res.json();
    expect(pkg.sessionId).toBe('ses_g');
    expect(pkg.instanceId).toBe(GINSTANCE);
    expect(pkg.v).toBe(1);
  });

  it('rejects a request with a missing document or signature (400)', async () => {
    const services = mockServices();
    services.guestProvisioning = guestService();
    const app = buildApp(services);
    const res = await app.inject({ method: 'POST', url: '/api/internal/guest/provision', payload: { document: 'x' } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a forged instance identity with 401 (never a 200)', async () => {
    const services = mockServices();
    services.guestProvisioning = guestService();
    const app = buildApp(services);
    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/guest/provision',
      payload: { ...presentedFor(), signature: Buffer.alloc(256, 9).toString('base64') },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a verified instance that is not bound to any session (403)', async () => {
    const services = mockServices();
    services.guestProvisioning = guestService({ binding: null });
    const app = buildApp(services);
    const res = await app.inject({ method: 'POST', url: '/api/internal/guest/provision', payload: presentedFor() });
    expect(res.statusCode).toBe(403);
  });
});
