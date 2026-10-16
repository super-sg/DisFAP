import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

// The critical cross-service contract: mint in the API, verify in the BROKER.
import { verifyConnectToken, type Keyring } from '@disfap/broker/src/session-token.js';
import { InMemoryNonceStore } from '@disfap/broker/src/nonce-store.js';

import { createSession, type CreateSessionDeps, type SessionPool } from '../src/sessions/create-session.js';
import type { SessionRepo, SessionRecord, CreateSessionData, SessionPatch, TemplateRepo, TemplateRecord, EventRecorder, AuditRecorder, CallerPrincipal, InstanceRepo } from '../src/ports.js';
import type { QuotaStore } from '../src/billing/quota.js';
import { VaultCredentialIssuer } from '../src/credentials/credential-issuer.js';
import { FakeVaultClient } from '../src/vault/vault-client.js';
import { InMemoryWrapTokenCache } from '../src/vault/wrap-token-cache.js';
import { VaultCredentialProvider } from '../src/integration/vault-credential-provider.js';
import { FakeCloudProvider } from '../src/cloud/provider.js';

const FIXED = new Date('2026-07-22T12:00:00Z');
const NOW_S = Math.floor(FIXED.getTime() / 1000);

function keyring(): Keyring {
  return { keys: new Map([['k_cur', randomBytes(32)]]), signingKid: 'k_cur' };
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
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
  async hasActiveForLicense(licenseId: string): Promise<boolean> {
    for (const row of this.rows.values()) {
      if (row.licenseId === licenseId && row.state !== 'ended' && row.state !== 'failed') return true;
    }
    return false;
  }
}

const template: TemplateRecord = {
  id: 'tpl_1',
  orgId: 'org_1',
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
  findActiveById: async (id) => (id === template.id ? template : null),
};

const quota: QuotaStore = {
  countActiveSessions: async () => 0,
  getLimits: async () => ({ maxConcurrent: 5, includedSeatSeconds: 1_000_000, overagePriceCents: 10 }),
  getUsedSeatSecondsThisPeriod: async () => 0,
};

function fakePool(): SessionPool {
  return {
    claim: async (templateId, sessionId) => ({
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

const principal: CallerPrincipal = { userId: 'usr_1', orgId: 'org_1', role: 'member' };

function buildDeps(
  kr: Keyring,
  vault: FakeVaultClient,
  wrapCache: InMemoryWrapTokenCache,
  extra: Partial<CreateSessionDeps> = {},
): CreateSessionDeps {
  return {
    sessions: new InMemorySessionRepo(),
    templates,
    quota,
    pool: fakePool(),
    credentialIssuer: new VaultCredentialIssuer(vault),
    wrapCache,
    events,
    audit,
    keyring: kr,
    config: { brokerUrl: 'wss://broker.test/tunnel', connectTokenTtlS: 60, credentialTtlS: 900 },
    now: () => FIXED,
    ...extra,
  };
}

describe('createSession', () => {
  it('mints a DFAP1 token the broker verifier accepts (cross-service contract)', async () => {
    const kr = keyring();
    const vault = new FakeVaultClient(() => FIXED.getTime());
    const wrapCache = new InMemoryWrapTokenCache(() => FIXED.getTime());
    const deps = buildDeps(kr, vault, wrapCache);

    const result = await createSession(principal, { templateId: 'tpl_1', clientIp: '203.0.113.9', clientUa: 'Mozilla/5.0' }, deps);

    expect(result.brokerUrl).toBe('wss://broker.test/tunnel');
    expect(result.sessionId).toMatch(/^ses_/);

    // THE contract check: the broker verifies our token with its own code.
    const verified = await verifyConnectToken(result.token, kr, new InMemoryNonceStore(), { now: NOW_S + 1 });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload).toMatchObject({
        sid: result.sessionId,
        sub: 'usr_1',
        org: 'org_1',
        aud: 'broker',
        scp: ['connect'],
      });
    }
  });

  it('produces a token that names a session and nothing else — no host/credential', async () => {
    const kr = keyring();
    const vault = new FakeVaultClient(() => FIXED.getTime());
    const deps = buildDeps(kr, vault, new InMemoryWrapTokenCache(() => FIXED.getTime()));
    const result = await createSession(principal, { templateId: 'tpl_1' }, deps);

    const payloadB64 = result.token.split('.')[2]!;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    const flat = JSON.stringify(payload).toLowerCase();
    for (const banned of ['host', 'password', 'username', 'port', 'rdp', '10.0.0']) {
      expect(flat).not.toContain(banned);
    }
  });

  it('closes the credential loop: the staged wrap token unwraps once to the VM credential', async () => {
    const kr = keyring();
    const vault = new FakeVaultClient(() => FIXED.getTime());
    const wrapCache = new InMemoryWrapTokenCache(() => FIXED.getTime());
    const deps = buildDeps(kr, vault, wrapCache);

    const result = await createSession(principal, { templateId: 'tpl_1' }, deps);

    // Resolver hands the broker the wrap token; provider unwraps it read-once.
    const wrapToken = wrapCache.take(result.sessionId);
    expect(wrapToken).toBeTruthy();
    const provider = new VaultCredentialProvider(vault);
    const cred = await provider.fetch(result.sessionId, wrapToken!);
    expect(cred.username).toBe('dfap-admin'); // windows template
    expect(cred.password).toBeTruthy();
    // Read-once: a second unwrap fails.
    await expect(provider.fetch(result.sessionId, wrapToken!)).rejects.toBeTruthy();
  });

  it('rejects a template from another org', async () => {
    const kr = keyring();
    const deps = buildDeps(kr, new FakeVaultClient(() => FIXED.getTime()), new InMemoryWrapTokenCache(() => FIXED.getTime()));
    await expect(
      createSession({ ...principal, orgId: 'org_other' }, { templateId: 'tpl_1' }, deps),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('allows a cross-org template ONLY when a validated marketplace grant authorizes it', async () => {
    const kr = keyring();
    const isLicensedTo = vi.fn(async () => true);
    const deps = buildDeps(kr, new FakeVaultClient(() => FIXED.getTime()), new InMemoryWrapTokenCache(() => FIXED.getTime()), {
      templateGrants: { isLicensedTo },
    });

    const result = await createSession(
      { ...principal, orgId: 'org_other' },
      { templateId: 'tpl_1', templateGrant: { licenseId: 'lic_1' } },
      deps,
    );

    expect(result.sessionId).toMatch(/^ses_/);
    // The grant is checked against the DATA, not merely for presence.
    expect(isLicensedTo).toHaveBeenCalledWith('lic_1', 'usr_1', 'tpl_1');
  });

  it('denies a cross-org template when the grant does not validate against the store', async () => {
    const kr = keyring();
    const deps = buildDeps(kr, new FakeVaultClient(() => FIXED.getTime()), new InMemoryWrapTokenCache(() => FIXED.getTime()), {
      templateGrants: { isLicensedTo: async () => false },
    });
    await expect(
      createSession(
        { ...principal, orgId: 'org_other' },
        { templateId: 'tpl_1', templateGrant: { licenseId: 'lic_1' } },
        deps,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('persists the marketplace license link on the session row (durable recovery)', async () => {
    const kr = keyring();
    const deps = buildDeps(kr, new FakeVaultClient(() => FIXED.getTime()), new InMemoryWrapTokenCache(() => FIXED.getTime()));

    const result = await createSession(principal, { templateId: 'tpl_1', licenseId: 'lic_42' }, deps);

    const repo = deps.sessions as InMemorySessionRepo;
    expect(repo.rows.get(result.sessionId)?.licenseId).toBe('lic_42');
  });

  it('terminates the launched VM when a later step fails (compensation)', async () => {
    const kr = keyring();
    const cloud = new FakeCloudProvider();
    const terminate = vi.spyOn(cloud, 'terminateInstance');
    const markState = vi.fn(async () => undefined);
    const issuer = new VaultCredentialIssuer(new FakeVaultClient(() => FIXED.getTime()));
    vi.spyOn(issuer, 'issue').mockRejectedValue(new Error('vault down'));
    const deps = buildDeps(kr, new FakeVaultClient(() => FIXED.getTime()), new InMemoryWrapTokenCache(() => FIXED.getTime()), {
      credentialIssuer: issuer,
      cloud,
      instances: { findById: async () => null, markState } as unknown as InstanceRepo,
    });

    await expect(createSession(principal, { templateId: 'tpl_1' }, deps)).rejects.toThrow('vault down');

    // The VM that was already launched is torn down, and the pool row is marked.
    expect(terminate).toHaveBeenCalledWith('i-fake-1');
    expect(markState).toHaveBeenCalledWith('pi_1', 'terminated', expect.any(Date));
  });

  it('defers readiness: stays allocating with instance + vault path, and the wrap token outlives a long boot', async () => {
    const kr = keyring();
    const vault = new FakeVaultClient(() => FIXED.getTime());
    let clock = FIXED.getTime();
    const wrapCache = new InMemoryWrapTokenCache(() => clock);
    const deps = buildDeps(kr, vault, wrapCache, { deferReadiness: true });

    const result = await createSession(principal, { templateId: 'tpl_1' }, deps);

    const repo = deps.sessions as InMemorySessionRepo;
    const row = repo.rows.get(result.sessionId)!;
    // NOT ready — a real VM is not usable the instant RunInstances returns.
    expect(row.state).toBe('allocating');
    expect(row.instanceId).toBe('pi_1');
    expect(row.vaultCredPath).toContain(result.sessionId);

    // Five minutes later (well past the old 90 s wrap-cache TTL) the staged
    // wrap token is still available, so a client that connects once the
    // readiness loop reports `ready` can still redeem it.
    clock = FIXED.getTime() + 5 * 60_000;
    expect(wrapCache.take(result.sessionId)).toBeTruthy();
  });
});
