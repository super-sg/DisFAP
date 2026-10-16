import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

// Cross-service contract: mint in the API, verify with the BROKER's own code.
import { verifyConnectToken, type Keyring } from '@disfap/broker/src/session-token.js';
import { InMemoryNonceStore } from '@disfap/broker/src/nonce-store.js';

import { SoftwareHsm } from '../src/crypto/hsm-rsa.js';
import { PairKeyService } from '../src/crypto/pair-keys.js';
import { InMemoryMarketplaceStore } from '../src/marketplace/license-store.js';
import { createSession, type CreateSessionDeps, type SessionPool } from '../src/sessions/create-session.js';
import { endSession } from '../src/sessions/end-session.js';
import { TwoThreadOrchestrator } from '../src/orchestrator/two-thread-orchestrator.js';
import { RentalReaper, ABANDONED_CLAIM_GRACE_MS } from '../src/marketplace/rental-reaper.js';
import { VaultCredentialIssuer } from '../src/credentials/credential-issuer.js';
import { FakeVaultClient } from '../src/vault/vault-client.js';
import { InMemoryWrapTokenCache } from '../src/vault/wrap-token-cache.js';
import { FakeCloudProvider } from '../src/cloud/provider.js';
import type {
  SessionRepo,
  SessionRecord,
  CreateSessionData,
  SessionPatch,
  TemplateRepo,
  TemplateRecord,
  EventRecorder,
  AuditRecorder,
  CallerPrincipal,
  InstanceRepo,
} from '../src/ports.js';
import type { QuotaStore } from '../src/billing/quota.js';
import type { UsageStore } from '../src/billing/usage.js';
import type { Principal } from '../src/auth/authenticator.js';

const FIXED = new Date('2026-07-22T12:00:00Z');
const NOW_S = Math.floor(FIXED.getTime() / 1000);
const MASTER = Buffer.alloc(32, 11);

const OWNER_ORG = 'org_owner_lab';
const OWNER = 'usr_owner';
const RENTEE_ORG = 'org_rentee_co';
const RENTEE = 'usr_rentee';
const TPL = 'tpl_owner_win_rdp';

const PRINCIPAL: Principal = { userId: RENTEE, orgId: RENTEE_ORG, role: 'member' };
const OWNER_PRINCIPAL: CallerPrincipal = { userId: OWNER, orgId: OWNER_ORG, role: 'member' };

function keyring(): Keyring {
  return { keys: new Map([['k_cur', randomBytes(32)]]), signingKid: 'k_cur' };
}

function fastHsm(): SoftwareHsm {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return new SoftwareHsm({ publicKeyPem: publicKey, privateKeyPem: privateKey, keyId: 'hsm-test', minModulusBits: 2048 });
}

class InMemorySessionRepo implements SessionRepo {
  private seq = 0;
  readonly rows = new Map<string, SessionRecord>();
  async create(data: CreateSessionData): Promise<SessionRecord> {
    const id = `ses_${++this.seq}`;
    const row: SessionRecord = {
      id,
      orgId: data.orgId,
      userId: data.userId,
      templateId: data.templateId,
      instanceId: null,
      licenseId: data.licenseId ?? null,
      state: data.state,
      requestedAt: FIXED,
      readyAt: null,
      firstPixelAt: null,
      connectedAt: null,
      disconnectedAt: null,
      endedAt: null,
      endReason: null,
      billableSeconds: null,
      vaultCredPath: null,
      clientIp: data.clientIp ?? null,
      clientUa: data.clientUa ?? null,
    };
    this.rows.set(id, row);
    return { ...row };
  }
  async update(id: string, patch: SessionPatch): Promise<SessionRecord> {
    const row = this.rows.get(id);
    if (!row) throw new Error('no such session');
    Object.assign(row, patch);
    return { ...row };
  }
  async findById(id: string): Promise<SessionRecord | null> {
    return this.rows.get(id) ?? null;
  }
  async hasActiveForLicense(licenseId: string): Promise<boolean> {
    for (const row of this.rows.values()) {
      if (row.licenseId === licenseId && row.state !== 'ended' && row.state !== 'failed') return true;
    }
    return false;
  }
}

/** Template owned by the OTHER org — the audit-C2 cross-org case. */
const ownerTemplate: TemplateRecord = {
  id: TPL,
  orgId: OWNER_ORG,
  os: 'windows',
  connectionProtocol: 'rdp',
  guacParams: { width: 1920, height: 1080, dpi: 96 },
  idleTimeoutS: 900,
  maxSessionS: 28800,
  recordingEnabled: false,
  gpu: false,
  active: true,
};

const templates: TemplateRepo = {
  findActiveById: async (id) => (id === TPL ? ownerTemplate : null),
};

const quota: QuotaStore = {
  countActiveSessions: async () => 0,
  getLimits: async () => ({ maxConcurrent: 5, includedSeatSeconds: 1_000_000, overagePriceCents: 10 }),
  getUsedSeatSecondsThisPeriod: async () => 0,
};

function fakePool(): SessionPool {
  return {
    claim: async (templateId) => ({
      coldLaunched: true,
      instance: {
        id: 'pi_1',
        cloudInstanceId: 'i-fake-1',
        templateId,
        region: 'us-east-1',
        az: 'us-east-1a',
        privateIp: '10.0.0.7',
        state: 'provisioning',
        expiresAt: new Date('2026-07-22T20:00:00Z'),
        hourlyCostUsd: 0.0168,
      },
    }),
  };
}

const events: EventRecorder = { record: async () => undefined };
const audit: AuditRecorder = { record: async () => undefined };

interface Rig {
  store: InMemoryMarketplaceStore;
  sessions: InMemorySessionRepo;
  cloud: FakeCloudProvider;
  instances: InstanceRepo & { markState: ReturnType<typeof vi.fn> };
  deps: CreateSessionDeps;
  orchestrator: TwoThreadOrchestrator;
  licenseId: string;
  reportMeterEvent: ReturnType<typeof vi.fn>;
}

async function buildRig(
  opts: { pool?: SessionPool; terminateSession?: (sessionId: string) => Promise<{ state: string }> } = {},
): Promise<Rig> {
  const hsm = fastHsm();
  const store = new InMemoryMarketplaceStore();
  const license = await store.create(OWNER, {
    softwareName: 'MATLAB & Simulink R2024b',
    version: 'R2024b',
    category: 'engineering',
    description: 'Numerical computing',
    os: 'windows',
    hourlyRateUsd: 4.5,
    ownerName: 'Academic License Pool',
    templateId: TPL,
    encryptedCredentials: hsm.encrypt(JSON.stringify({ username: 'matlab_user', password: 'DisFAP_Session_Password_2026!' })),
  });

  const sessions = new InMemorySessionRepo();
  const vault = new FakeVaultClient(() => FIXED.getTime());
  const wrapCache = new InMemoryWrapTokenCache(() => FIXED.getTime());
  const cloud = new FakeCloudProvider();
  const instances = {
    findById: vi.fn(async (id: string) =>
      id === 'pi_1' ? { id: 'pi_1', cloudInstanceId: 'i-fake-1', hourlyCostUsd: 0.0168, region: 'us-east-1' } : null,
    ),
    markState: vi.fn(async () => undefined),
  } as unknown as Rig['instances'];
  const usage: UsageStore = { createUsageRecord: vi.fn(async () => undefined) };

  const deps: CreateSessionDeps = {
    sessions,
    templates,
    quota,
    pool: opts.pool ?? fakePool(),
    credentialIssuer: new VaultCredentialIssuer(vault),
    wrapCache,
    events,
    audit,
    keyring: keyring(),
    config: { brokerUrl: 'wss://broker.test/tunnel', connectTokenTtlS: 60, credentialTtlS: 900 },
    templateGrants: store,
    cloud,
    instances,
    now: () => FIXED,
  };

  // Real teardown used by the orchestrator's post-creation compensation.
  const runEndSession = (sid: string) =>
    endSession(sid, 'error', null, {
      sessions,
      instances,
      cloud,
      credentialIssuer: deps.credentialIssuer,
      wrapCache,
      usage,
      events,
      audit,
      marketplace: store,
      now: () => FIXED,
    });

  const reportMeterEvent = vi.fn(async () => ({ id: 'mev_1' }));
  const orchestrator = new TwoThreadOrchestrator({
    hsm,
    marketplace: store,
    createSession: (p, i) => createSession(p, i, deps),
    terminateSession: opts.terminateSession ?? runEndSession,
    meter: { reportMeterEvent },
    pairKeys: new PairKeyService(MASTER),
  });

  return { store, sessions, cloud, instances, deps, orchestrator, licenseId: license.id, reportMeterEvent };
}

describe('marketplace rent → real createSession integration', () => {
  it('launches a template owned by ANOTHER org when the license is rented to the caller', async () => {
    const rig = await buildRig();

    const result = await rig.orchestrator.rentAndOrchestrate(PRINCIPAL, {
      licenseId: rig.licenseId,
      hoursRequested: 1,
    });

    // A real, verified session was produced by the real createSession.
    expect(result.sessionId).toMatch(/^ses_/);
    const verified = await verifyConnectToken(result.token, rig.deps.keyring, new InMemoryNonceStore(), {
      now: NOW_S + 1,
    });
    expect(verified.ok).toBe(true);

    // The session belongs to the RENTEE org but runs the OWNER's template.
    const session = await rig.sessions.findById(result.sessionId);
    expect(session?.orgId).toBe(RENTEE_ORG);
    expect(session?.userId).toBe(RENTEE);
    expect(session?.templateId).toBe(TPL);
    expect(session?.state).toBe('ready');

    // License state + rental ledger.
    const lic = await rig.store.findById(rig.licenseId);
    expect(lic?.status).toBe('rented');
    expect(lic?.currentRenteeId).toBe(RENTEE);
    const rental = await rig.store.findRentalBySession(result.sessionId);
    expect(rental?.licenseId).toBe(rig.licenseId);
    expect(rental?.meterEventId).toBe('mev_1');
  });

  it('denies the cross-org template when the license is NOT actively rented to the caller', async () => {
    const rig = await buildRig();

    // No claim happened → store.isLicensedTo() is false → 403, template isolation intact.
    await expect(
      createSession(PRINCIPAL, { templateId: TPL, templateGrant: { licenseId: rig.licenseId } }, rig.deps),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('denies the cross-org template when the grant names a different license/template', async () => {
    const rig = await buildRig();
    // Claim a DIFFERENT license that points at the owner's template; then request
    // the template via a grant for the real license — the template must match.
    await rig.store.claimAvailable(rig.licenseId, RENTEE);
    await expect(
      createSession(PRINCIPAL, { templateId: TPL, templateGrant: { licenseId: 'lic_other' } }, rig.deps),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('compensates a failed session creation: releases the claim, records no rental, meters nothing', async () => {
    const failingPool: SessionPool = {
      claim: async () => {
        throw new Error('no capacity');
      },
    };
    const rig = await buildRig({ pool: failingPool });

    await expect(
      rig.orchestrator.rentAndOrchestrate(PRINCIPAL, { licenseId: rig.licenseId, hoursRequested: 1 }),
    ).rejects.toThrow('no capacity');

    // Claim released → license available again.
    const lic = await rig.store.findById(rig.licenseId);
    expect(lic?.status).toBe('available');
    expect(lic?.currentRenteeId).toBeNull();

    // No rental row, no meter event, no fabricated success.
    expect(rig.reportMeterEvent).not.toHaveBeenCalled();
  });

  it('cleans up the launched VM when a later step fails, and still releases the claim', async () => {
    const rig = await buildRig();
    vi.spyOn(rig.deps.credentialIssuer, 'issue').mockRejectedValue(new Error('vault down'));
    const terminate = vi.spyOn(rig.cloud, 'terminateInstance');

    await expect(
      rig.orchestrator.rentAndOrchestrate(PRINCIPAL, { licenseId: rig.licenseId, hoursRequested: 1 }),
    ).rejects.toThrow('vault down');

    // The VM that was already launched is torn down (compensation, observable).
    expect(terminate).toHaveBeenCalledWith('i-fake-1');
    expect(rig.instances.markState).toHaveBeenCalledWith('pi_1', 'terminated', expect.any(Date));

    // The session is marked failed and the license is released.
    const failed = [...rig.sessions.rows.values()][0];
    expect(failed?.state).toBe('failed');
    expect((await rig.store.findById(rig.licenseId))?.status).toBe('available');
    expect(rig.reportMeterEvent).not.toHaveBeenCalled();
  });

  it('compensates a rental-persistence failure: terminates the session, releases the license, meters nothing', async () => {
    const rig = await buildRig();
    const terminate = vi.spyOn(rig.cloud, 'terminateInstance');
    vi.spyOn(rig.store, 'recordRental').mockRejectedValueOnce(new Error('rental db down'));

    await expect(
      rig.orchestrator.rentAndOrchestrate(PRINCIPAL, { licenseId: rig.licenseId, hoursRequested: 1 }),
    ).rejects.toThrow('rental db down');

    // The freshly created session (and its VM) was torn down.
    const session = [...rig.sessions.rows.values()][0];
    expect(session?.state).toBe('ended');
    expect(session?.licenseId).toBe(rig.licenseId);
    expect(terminate).toHaveBeenCalledWith('i-fake-1');

    // The license is released ONLY because the session is confirmed terminal.
    const lic = await rig.store.findById(rig.licenseId);
    expect(lic?.status).toBe('available');
    expect(lic?.currentRenteeId).toBeNull();

    // No rental row was created and nothing was metered.
    expect(await rig.store.findRentalBySession(session!.id)).toBeNull();
    expect(rig.reportMeterEvent).not.toHaveBeenCalled();
  });

  it('keeps the claim when teardown cannot be confirmed, and the reaper holds until the session is terminal', async () => {
    const rig = await buildRig({
      terminateSession: async () => {
        throw new Error('teardown failed');
      },
    });
    vi.spyOn(rig.store, 'recordRental').mockRejectedValueOnce(new Error('rental db down'));

    await expect(
      rig.orchestrator.rentAndOrchestrate(PRINCIPAL, { licenseId: rig.licenseId, hoursRequested: 1 }),
    ).rejects.toThrow('rental db down');

    // Fail-closed: the license stays claimed; the session may still be live.
    const session = [...rig.sessions.rows.values()][0];
    expect(session?.state).toBe('ready');
    expect(session?.licenseId).toBe(rig.licenseId);
    expect((await rig.store.findById(rig.licenseId))?.status).toBe('rented');

    // Drive the clock past the abandoned-claim grace (the store stamps in real
    // time) and run the REAL reaper wired the way server.ts wires it.
    const reaper = new RentalReaper({
      store: rig.store,
      sessions: {
        stateOf: async (sid) => (await rig.sessions.findById(sid))?.state ?? null,
        hasActiveSessionForLicense: (licenseId) => rig.sessions.hasActiveForLicense(licenseId),
      },
      now: () => new Date(Date.now() + ABANDONED_CLAIM_GRACE_MS + 60_000),
    });

    const held = await reaper.reconcile();
    expect(held.releasedClaims).toEqual([]);
    expect(held.heldClaims).toContain(rig.licenseId);
    expect((await rig.store.findById(rig.licenseId))?.status).toBe('rented');

    // Once the session is confirmed terminal, the next pass safely releases it.
    await rig.sessions.update(session!.id, { state: 'ended', endedAt: FIXED, endReason: 'error' });
    const released = await reaper.reconcile();
    expect(released.releasedClaims).toContain(rig.licenseId);
    expect((await rig.store.findById(rig.licenseId))?.status).toBe('available');
  });

  it('does not terminate a valid session when only the Stripe meter fails', async () => {
    const rig = await buildRig();
    const terminate = vi.spyOn(rig.cloud, 'terminateInstance');
    rig.reportMeterEvent.mockRejectedValueOnce(new Error('stripe down'));

    const result = await rig.orchestrator.rentAndOrchestrate(PRINCIPAL, { licenseId: rig.licenseId, hoursRequested: 1 });

    // The rent succeeded, the session is live, and the license stays rented.
    expect(result.sessionId).toMatch(/^ses_/);
    const session = await rig.sessions.findById(result.sessionId);
    expect(session?.state).toBe('ready');
    expect((await rig.store.findById(rig.licenseId))?.status).toBe('rented');
    expect(terminate).not.toHaveBeenCalled();

    // Recoverable obligation preserved: the rental exists with a null meter id.
    const rental = await rig.store.findRentalBySession(result.sessionId);
    expect(rental?.meterEventId).toBeNull();
  });

  it('lets the OWNER org launch its own cross-org template without a grant (unchanged path)', async () => {
    const rig = await buildRig();
    const result = await createSession(OWNER_PRINCIPAL, { templateId: TPL }, rig.deps);
    expect(result.sessionId).toMatch(/^ses_/);
  });
});
