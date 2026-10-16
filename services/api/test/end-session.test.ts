import { describe, expect, it, vi } from 'vitest';

import { endSession, type EndSessionDeps } from '../src/sessions/end-session.js';
import type {
  SessionRepo,
  SessionRecord,
  EventRecorder,
  AuditRecorder,
  InstanceRepo,
  InstanceRecord,
} from '../src/ports.js';
import type { UsageStore } from '../src/billing/usage.js';
import type { CredentialIssuer } from '../src/credentials/credential-issuer.js';
import { FakeCloudProvider } from '../src/cloud/provider.js';
import { InMemoryWrapTokenCache } from '../src/vault/wrap-token-cache.js';

const FIXED = new Date('2026-07-22T12:00:00Z');

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'ses_rent_1',
    orgId: 'org_1',
    userId: 'usr_1',
    templateId: 'tpl_1',
    instanceId: 'pi_1',
    licenseId: null,
    state: 'connected',
    requestedAt: FIXED,
    readyAt: FIXED,
    firstPixelAt: FIXED,
    connectedAt: FIXED,
    disconnectedAt: null,
    endedAt: null,
    endReason: null,
    billableSeconds: null,
    vaultCredPath: null,
    clientIp: null,
    clientUa: null,
    ...overrides,
  };
}

interface Harness {
  deps: EndSessionDeps;
  sessions: SessionRepo & { rows: Map<string, SessionRecord> };
  credentialIssuer: CredentialIssuer & { revoke: ReturnType<typeof vi.fn> };
  completeForSession: ReturnType<typeof vi.fn>;
  events: EventRecorder & { record: ReturnType<typeof vi.fn> };
  usage: UsageStore & { createUsageRecord: ReturnType<typeof vi.fn> };
}

function harness(initial: SessionRecord): Harness {
  const rows = new Map([[initial.id, { ...initial }]]);
  const sessions: Harness['sessions'] = {
    rows,
    create: async () => {
      throw new Error('unused');
    },
    update: async (id, patch) => {
      const row = rows.get(id)!;
      Object.assign(row, patch);
      return { ...row };
    },
    findById: async (id) => (rows.get(id) ? { ...rows.get(id)! } : null),
    hasActiveForLicense: async (licenseId) => {
      for (const row of rows.values()) {
        if (row.licenseId === licenseId && row.state !== 'ended' && row.state !== 'failed') return true;
      }
      return false;
    },
  };
  const instance: InstanceRecord = { id: 'pi_1', cloudInstanceId: 'i-fake-1', hourlyCostUsd: 0.0168, region: 'us-east-1' };
  const instances: InstanceRepo = {
    findById: async (id) => (id === instance.id ? instance : null),
    markState: vi.fn(async () => undefined),
  };
  const credentialIssuer: CredentialIssuer = {
    issue: async () => {
      throw new Error('unused');
    },
    revoke: vi.fn(async () => undefined),
    pathFor: (sid) => `sessions/${sid}/rdp`,
  };
  const events = { record: vi.fn(async () => undefined) };
  const audit = { record: vi.fn(async () => undefined) };
  const usage = { createUsageRecord: vi.fn(async () => undefined) };
  const completeForSession = vi.fn(async () => undefined);

  return {
    sessions,
    completeForSession,
    events,
    usage,
    credentialIssuer: credentialIssuer as Harness['credentialIssuer'],
    deps: {
      sessions,
      instances,
      cloud: new FakeCloudProvider(),
      credentialIssuer,
      wrapCache: new InMemoryWrapTokenCache(() => FIXED.getTime()),
      usage,
      events,
      audit: audit as unknown as AuditRecorder,
      marketplace: { completeForSession },
      now: () => FIXED,
    },
  };
}

describe('endSession — marketplace release (auto-offboarding)', () => {
  it('releases the rented license when the session ends', async () => {
    const h = harness(sessionRecord());

    const result = await endSession('ses_rent_1', 'user', 'usr_1', h.deps);

    expect(result.alreadyTerminal).toBe(false);
    expect(result.state).toBe('ended');
    // The rental tied to this session was closed (license back to available).
    expect(h.completeForSession).toHaveBeenCalledTimes(1);
    expect(h.completeForSession).toHaveBeenCalledWith('ses_rent_1');
    // Usage still recorded.
    expect(h.usage.createUsageRecord).toHaveBeenCalledTimes(1);
  });

  it('still attempts the rental release when the session is already terminal', async () => {
    const h = harness(sessionRecord({ state: 'ended', endedAt: FIXED, endReason: 'user' }));

    const result = await endSession('ses_rent_1', 'user', 'usr_1', h.deps);

    expect(result.alreadyTerminal).toBe(true);
    // H1: terminal states must not skip the release attempt (a session that
    // failed before releasing would otherwise leave its license stuck rented).
    expect(h.completeForSession).toHaveBeenCalledTimes(1);
    expect(h.completeForSession).toHaveBeenCalledWith('ses_rent_1');
  });

  it('does not fail an already-terminal teardown when the release throws', async () => {
    const h = harness(sessionRecord({ state: 'failed', endedAt: FIXED, endReason: 'error' }));
    h.completeForSession.mockRejectedValueOnce(new Error('marketplace unavailable'));

    const result = await endSession('ses_rent_1', 'error', 'usr_1', h.deps);

    expect(result.alreadyTerminal).toBe(true);
    expect(result.state).toBe('failed');
  });
});

describe('endSession — credential revocation is retried, never blocks teardown', () => {
  it('retries a transient revoke failure until it succeeds', async () => {
    const h = harness(sessionRecord());
    h.credentialIssuer.revoke
      .mockRejectedValueOnce(new Error('vault unavailable'))
      .mockRejectedValueOnce(new Error('vault unavailable'));

    const result = await endSession('ses_rent_1', 'user', 'usr_1', h.deps);

    expect(result.state).toBe('ended');
    expect(h.credentialIssuer.revoke).toHaveBeenCalledTimes(3);
  });

  it('still ends the session when revocation keeps failing (best effort)', async () => {
    const h = harness(sessionRecord());
    h.credentialIssuer.revoke.mockRejectedValue(new Error('vault unavailable'));

    const result = await endSession('ses_rent_1', 'user', 'usr_1', h.deps);

    expect(result.state).toBe('ended');
    expect(h.credentialIssuer.revoke).toHaveBeenCalledTimes(3);
  });
});
