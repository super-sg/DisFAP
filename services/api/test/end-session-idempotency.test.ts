/**
 * Deterministic teardown (Objective C).
 *
 * Every ending path — user, admin, grace expiration, security kill, readiness
 * failure — shares `endSession`. These tests pin the observed behaviour under
 * the cases that used to double-charge or leak:
 *
 *  - repeated calls (double click / retried request),
 *  - concurrent calls (user end racing the reaper),
 *  - a crash between the usage write and `ended`, retried by the reaper.
 *
 * The invariant is one *effect*: one usage row, one rental release, one VM
 * termination, one `ended` event/audit entry.
 */

import { describe, expect, it, vi } from 'vitest';

import { endSession, type EndSessionDeps } from '../src/sessions/end-session.js';
import type { SessionRecord, AuditEntry } from '../src/ports.js';
import type { UsageRecordData, UsageStore } from '../src/billing/usage.js';
import type { CredentialIssuer } from '../src/credentials/credential-issuer.js';
import { InMemoryWrapTokenCache } from '../src/vault/wrap-token-cache.js';
import { FakeSessionRepo } from './support/fake-session-repo.js';

const T0 = new Date('2026-11-12T12:00:00Z');
const SID = 'ses_1';

interface Rig {
  repo: FakeSessionRepo;
  deps: EndSessionDeps;
  usageRows: Map<string, UsageRecordData>;
  cloud: { terminated: string[]; terminateCalls: number };
  releaseEffects: () => number;
  events: { record: ReturnType<typeof vi.fn> };
  audit: { record: ReturnType<typeof vi.fn> };
  finalizations: () => number;
}

function rig(): Rig {
  const repo = new FakeSessionRepo(() => T0);
  const usageRows = new Map<string, UsageRecordData>();
  const usage: UsageStore = {
    createUsageRecord: vi.fn(async (data: UsageRecordData) => {
      if (usageRows.has(data.sessionId)) throw new Error('unique violation: usage_records.session_id');
      usageRows.set(data.sessionId, data);
    }),
    hasForSession: async (sessionId) => usageRows.has(sessionId),
  };

  const cloud = {
    terminated: [] as string[],
    terminateCalls: 0,
    terminateInstance: vi.fn(async (id: string) => {
      cloud.terminateCalls += 1;
      // Provider-idempotent: terminating an already-terminated instance is a
      // no-op at the effect level (AWS/EC2 behaves this way).
      if (!cloud.terminated.includes(id)) cloud.terminated.push(id);
    }),
    describeManaged: async () => [],
    describeInstance: async () => null,
  };

  const releaseEffects = new Set<string>();
  let releases = 0;
  const events = {
    record: vi.fn(async (_sid: string, _kind: string, _actor: string | null, _detail: Record<string, unknown>) => undefined),
  };
  const audit = { record: vi.fn(async (_entry: AuditEntry) => undefined) };
  const credentialIssuer: CredentialIssuer = {
    issue: async () => {
      throw new Error('unused');
    },
    reissue: async () => null,
    revoke: vi.fn(async () => undefined),
    pathFor: (sid) => `sessions/${sid}/rdp`,
  };

  const deps: EndSessionDeps = {
    sessions: repo,
    instances: {
      findById: async (id) =>
        id === 'pi_1' ? { id: 'pi_1', cloudInstanceId: 'i-1', hourlyCostUsd: 0.02, region: 'us-east-1' } : null,
      markState: vi.fn(async () => undefined),
    },
    cloud: cloud as unknown as EndSessionDeps['cloud'],
    credentialIssuer,
    wrapCache: new InMemoryWrapTokenCache(() => T0.getTime()),
    usage,
    events,
    audit,
    marketplace: {
      completeForSession: async (sid) => {
        if (!releaseEffects.has(sid)) {
          releaseEffects.add(sid);
          releases += 1;
        }
      },
    },
    now: () => T0,
  };

  return {
    repo,
    deps,
    usageRows,
    cloud,
    releaseEffects: () => releases,
    events,
    audit,
    finalizations: () => repo.finalizations.length,
  };
}

function seed(repo: FakeSessionRepo, overrides: Partial<SessionRecord> = {}) {
  return repo.seed({
    id: SID,
    state: 'connected',
    instanceId: 'pi_1',
    requestedAt: T0,
    readyAt: T0,
    connectedAt: T0,
    firstPixelAt: T0,
    ...overrides,
  });
}

describe('repeated termination', () => {
  it('the second call is a cheap no-op on every one-time effect', async () => {
    const r = rig();
    seed(r.repo);

    const first = await endSession(SID, 'user', 'usr_1', r.deps);
    const second = await endSession(SID, 'user', 'usr_1', r.deps);

    expect(first.alreadyTerminal).toBe(false);
    expect(second.alreadyTerminal).toBe(true);
    expect(r.repo.rows.get(SID)!.state).toBe('ended');
    expect(r.usageRows.size).toBe(1);
    expect(r.releaseEffects()).toBe(1);
    expect(r.cloud.terminated).toEqual(['i-1']);
    expect(r.events.record.mock.calls.filter((c) => c[1] === 'ended')).toHaveLength(1);
    expect(r.audit.record).toHaveBeenCalledTimes(1);
    expect(r.finalizations()).toBe(1);
  });

  it('still attempts the rental release on an already-terminal row (no stuck license)', async () => {
    const r = rig();
    seed(r.repo, { state: 'failed', endReason: 'error' });

    const result = await endSession(SID, 'user', 'usr_1', r.deps);

    expect(result.alreadyTerminal).toBe(true);
    // The store's release is itself idempotent, so this is the same single effect.
    expect(r.releaseEffects()).toBe(1);
    expect(r.cloud.terminated).toEqual([]); // nothing left to terminate
    expect(r.usageRows.size).toBe(0);
  });
});

describe('concurrent termination', () => {
  it('a triple end (user click + reaper + admin) yields one effect of each kind', async () => {
    const r = rig();
    seed(r.repo);

    const results = await Promise.all([
      endSession(SID, 'user', 'usr_1', r.deps),
      endSession(SID, 'idle_timeout', null, r.deps),
      endSession(SID, 'admin', 'usr_admin', r.deps),
    ]);

    // Concurrent callers observe their own point in time; at least the winner
    // reports the terminal row and the durable state converges to `ended`.
    expect(results.some((x) => x.state === 'ended')).toBe(true);
    expect(r.repo.rows.get(SID)!.state).toBe('ended');
    expect(r.usageRows.size).toBe(1);
    expect(r.releaseEffects()).toBe(1);
    expect(r.cloud.terminated).toEqual(['i-1']); // one VM (provider-idempotent)
    expect(r.events.record.mock.calls.filter((c) => c[1] === 'terminating')).toHaveLength(1);
    expect(r.events.record.mock.calls.filter((c) => c[1] === 'ended')).toHaveLength(1);
    expect(r.audit.record).toHaveBeenCalledTimes(1);
    expect(r.finalizations()).toBe(1);
    // Billing is pinned to the first transition, not recomputed by a loser.
    const billable = r.usageRows.get(SID)!.billableSeconds;
    expect(results.every((x) => x.billableSeconds === billable)).toBe(true);
  });

  it('two different instances cannot both bill the same session', async () => {
    const r = rig();
    seed(r.repo, { instanceId: 'pi_1' });

    await Promise.all([endSession(SID, 'user', 'usr_1', r.deps), endSession(SID, 'idle_timeout', null, r.deps)]);
    await endSession(SID, 'idle_timeout', null, r.deps);

    expect([...r.usageRows.keys()]).toEqual([SID]);
    const row = r.usageRows.get(SID)!;
    expect(row.computeCostUsd).toBeGreaterThan(0);
  });
});

describe('partial failure recovery', () => {
  it('a crash before finalize leaves `terminating`; the retry converges without double-billing', async () => {
    const r = rig();
    seed(r.repo);
    r.repo.failNextFinalize = true;

    await expect(endSession(SID, 'user', 'usr_1', r.deps)).rejects.toThrow(/simulated crash/);

    // The VM and usage work completed before the crash; the row is not `ended`.
    expect(r.repo.rows.get(SID)!.state).toBe('terminating');
    expect(r.usageRows.size).toBe(1);
    expect(r.cloud.terminated).toEqual(['i-1']);
    expect(r.events.record.mock.calls.filter((c) => c[1] === 'ended')).toHaveLength(0);

    const retry = await endSession(SID, 'user', 'usr_1', r.deps);

    expect(retry.state).toBe('ended');
    expect(r.repo.rows.get(SID)!.state).toBe('ended');
    expect(r.usageRows.size).toBe(1); // the unique index prevented a second row
    expect(r.releaseEffects()).toBe(1);
    expect(r.events.record.mock.calls.filter((c) => c[1] === 'ended')).toHaveLength(1);
    expect(r.audit.record).toHaveBeenCalledTimes(1);
  });

  it('a usage write that failed before commit is retried exactly once', async () => {
    const r = rig();
    seed(r.repo);
    // First insert fails like a transient DB error; the row is not persisted.
    const original = r.deps.usage.createUsageRecord;
    let attempts = 0;
    r.deps.usage.createUsageRecord = async (data) => {
      attempts += 1;
      if (attempts === 1) throw new Error('connection reset');
      return original(data);
    };

    const first = await endSession(SID, 'user', 'usr_1', r.deps);
    // A usage failure leaves the row in `terminating`, never `ended` without a
    // bill: this is the durable retry handle.
    expect(first.state).toBe('terminating');
    expect(r.repo.rows.get(SID)!.state).toBe('terminating');
    expect(r.usageRows.size).toBe(0);
    expect(r.events.record.mock.calls.filter((c) => c[1] === 'ended')).toHaveLength(0);
    expect(r.audit.record).not.toHaveBeenCalled();

    // The reaper/ops replay retries the same authority; the insert now lands.
    const retry = await endSession(SID, 'user', 'usr_1', r.deps);
    expect(retry.state).toBe('ended');
    expect(attempts).toBe(2);
    expect(r.usageRows.size).toBe(1);
    expect(r.events.record.mock.calls.filter((c) => c[1] === 'ended')).toHaveLength(1);
    expect(r.audit.record).toHaveBeenCalledTimes(1);
  });
});
