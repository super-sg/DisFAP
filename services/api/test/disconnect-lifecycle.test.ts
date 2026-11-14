/**
 * Disconnect lifecycle (Objective B/D).
 *
 * Proves the real execution path, not just the state-machine table:
 *  - an ordinary tunnel drop persists a deadline and preserves the VM;
 *  - reconnecting inside the window clears it and returns to CONNECTED;
 *  - the durable reaper tears down exactly what expired, through `endSession`;
 *  - a reconnect that wins the race can never be terminated by a stale pass;
 *  - security-fatal termination gets NO grace window.
 */

import { describe, expect, it, vi } from 'vitest';

import { endSession, type EndSessionDeps } from '../src/sessions/end-session.js';
import { SessionLifecycleReaper } from '../src/sessions/lifecycle-reaper.js';
import { PrismaSessionResolver } from '../src/integration/prisma-session-resolver.js';
import type { SessionConnectStore } from '../src/integration/prisma-session-resolver.js';
import type { SessionRecord } from '../src/ports.js';
import type { AuditEntry } from '../src/ports.js';
import type { UsageRecordData, UsageStore } from '../src/billing/usage.js';
import type { CredentialIssuer } from '../src/credentials/credential-issuer.js';
import { InMemoryWrapTokenCache } from '../src/vault/wrap-token-cache.js';
import { FakeSessionRepo } from './support/fake-session-repo.js';

const T0 = new Date('2026-11-12T12:00:00Z');
const SID = 'ses_1';
const GRACE_S = 30;

/**
 * Mirrors `PrismaSessionConnectStore`'s conditional writes. The methods have no
 * `await` before their state mutation, so they are atomic with respect to other
 * awaited callers — the property the race tests depend on.
 */
class FakeConnectStore implements SessionConnectStore {
  constructor(
    private readonly repo: FakeSessionRepo,
    private readonly now: () => Date,
  ) {}

  async loadForConnect(sid: string) {
    const row = this.repo.rows.get(sid);
    if (!row) return null;
    return {
      sid: row.id,
      state: row.state,
      org: row.orgId,
      sub: row.userId,
      protocol: 'rdp' as const,
      host: '10.0.0.5',
      width: 1920,
      height: 1080,
      dpi: 96,
      recordingEnabled: false,
      disconnectDeadlineAt: row.disconnectDeadlineAt,
    };
  }

  async markConnected(sid: string, at: Date): Promise<boolean> {
    const row = this.repo.rows.get(sid);
    if (!row) return false;
    const reconnectable =
      row.state === 'ready' ||
      row.state === 'idle' ||
      row.state === 'connected' ||
      (row.state === 'disconnected' &&
        row.disconnectDeadlineAt !== null &&
        row.disconnectDeadlineAt.getTime() > at.getTime());
    if (!reconnectable) return false;
    row.state = 'connected';
    row.connectedAt ??= at;
    row.firstPixelAt ??= at;
    row.disconnectDeadlineAt = null;
    return true;
  }

  async markDisconnected(sid: string, at: Date, deadline: Date): Promise<boolean> {
    const row = this.repo.rows.get(sid);
    if (!row || (row.state !== 'connected' && row.state !== 'idle')) return false;
    row.state = 'disconnected';
    row.disconnectedAt = at;
    row.disconnectDeadlineAt = deadline;
    return true;
  }

  async markTerminating(sid: string, _reason: string, at: Date): Promise<void> {
    const row = this.repo.rows.get(sid);
    if (!row || row.state === 'ended' || row.state === 'failed') return;
    row.state = 'terminating';
    row.disconnectedAt ??= at;
    row.disconnectDeadlineAt = null;
  }
}

interface Rig {
  repo: FakeSessionRepo;
  store: FakeConnectStore;
  resolver: PrismaSessionResolver;
  reaper: SessionLifecycleReaper;
  deps: EndSessionDeps;
  clock: { now: number };
  cloud: { terminated: string[] };
  usageRows: Map<string, UsageRecordData>;
  releaseCount: () => number;
  events: { record: ReturnType<typeof vi.fn> };
  audit: { record: ReturnType<typeof vi.fn> };
  revoke: ReturnType<typeof vi.fn>;
}

function rig(): Rig {
  const clock = { now: T0.getTime() };
  const repo = new FakeSessionRepo(() => new Date(clock.now));
  const store = new FakeConnectStore(repo, () => new Date(clock.now));
  const wrapCache = new InMemoryWrapTokenCache(() => clock.now);

  const cloud = {
    terminated: [] as string[],
    terminateInstance: vi.fn(async (id: string) => {
      cloud.terminated.push(id);
    }),
    describeManaged: async () => [],
    describeInstance: async () => null,
  };

  const usageRows = new Map<string, UsageRecordData>();
  const usage: UsageStore = {
    createUsageRecord: vi.fn(async (data: UsageRecordData) => {
      // Same uniqueness guarantee as the DB index.
      if (usageRows.has(data.sessionId)) throw new Error('duplicate usage record');
      usageRows.set(data.sessionId, data);
    }),
    hasForSession: async (sessionId) => usageRows.has(sessionId),
  };

  const revoke = vi.fn(async () => undefined);
  const credentialIssuer: CredentialIssuer = {
    issue: async () => {
      throw new Error('unused');
    },
    reissue: async () => null,
    revoke,
    pathFor: (sid) => `sessions/${sid}/rdp`,
  };

  const released = new Set<string>();
  let releases = 0;
  const events = {
    record: vi.fn(async (_sid: string, _kind: string, _actor: string | null, _detail: Record<string, unknown>) => undefined),
  };
  const audit = { record: vi.fn(async (_entry: AuditEntry) => undefined) };

  const deps: EndSessionDeps = {
    sessions: repo,
    instances: {
      findById: async (id) =>
        id === 'pi_1'
          ? { id: 'pi_1', cloudInstanceId: 'i-1', hourlyCostUsd: 0.02, region: 'us-east-1' }
          : null,
      markState: vi.fn(async () => undefined),
    },
    cloud: cloud as unknown as EndSessionDeps['cloud'],
    credentialIssuer,
    wrapCache,
    usage,
    events,
    audit,
    marketplace: {
      completeForSession: async (sid) => {
        if (!released.has(sid)) {
          released.add(sid);
          releases += 1;
        }
      },
    },
    now: () => new Date(clock.now),
  };

  const resolver = new PrismaSessionResolver({
    store,
    wrapCache,
    graceSeconds: GRACE_S,
    now: () => new Date(clock.now),
  });
  const reaper = new SessionLifecycleReaper({
    sessions: repo,
    endSession: (sid, reason, actor) => endSession(sid, reason, actor, deps),
    now: () => new Date(clock.now),
    terminatingRetryAfterMs: 0,
  });

  return {
    repo,
    store,
    resolver,
    reaper,
    deps,
    clock,
    cloud,
    usageRows,
    releaseCount: () => releases,
    events,
    audit,
    revoke,
  };
}

function connectedSession(overrides: Partial<SessionRecord> = {}): Partial<SessionRecord> & { id: string } {
  return {
    id: SID,
    state: 'connected',
    instanceId: 'pi_1',
    connectedAt: T0,
    requestedAt: T0,
    readyAt: T0,
    ...overrides,
  };
}

describe('ordinary tunnel drop → grace window', () => {
  it('persists a deadline and keeps the VM and rental alive', async () => {
    const r = rig();
    r.repo.seed(connectedSession());

    await r.resolver.markDisconnected(SID, 'client closed');

    const row = r.repo.rows.get(SID)!;
    expect(row.state).toBe('disconnected');
    expect(row.disconnectedAt).toEqual(T0);
    expect(row.disconnectDeadlineAt).toEqual(new Date(T0.getTime() + GRACE_S * 1000));
    // Not torn down immediately.
    expect(r.cloud.terminated).toEqual([]);
    expect(r.releaseCount()).toBe(0);
    expect(r.usageRows.size).toBe(0);
  });

  it('duplicate close events do not extend the first deadline', async () => {
    const r = rig();
    r.repo.seed(connectedSession());
    await r.resolver.markDisconnected(SID, 'client closed');
    const first = r.repo.rows.get(SID)!.disconnectDeadlineAt;

    r.clock.now += 10_000;
    await r.resolver.markDisconnected(SID, 'client error');

    expect(r.repo.rows.get(SID)!.disconnectDeadlineAt).toEqual(first);
  });

  it('reconnecting inside the window restores CONNECTED and clears the deadline', async () => {
    const r = rig();
    r.repo.seed(connectedSession({ connectedAt: T0 }));
    const wrapCache = (r.deps.wrapCache as InMemoryWrapTokenCache);
    await r.resolver.markDisconnected(SID, 'client closed');

    r.clock.now += 10_000;
    wrapCache.put(SID, 'jti-new', 'wrap-new', 60);
    const resolved = await r.resolver.resolve(SID, 'jti-new');
    expect(resolved?.state).toBe('disconnected');

    const claimed = await r.resolver.markConnected(SID);
    expect(claimed).toBe(true);
    const row = r.repo.rows.get(SID)!;
    expect(row.state).toBe('connected');
    expect(row.disconnectDeadlineAt).toBeNull();
    // The original billing start is preserved across the reconnect.
    expect(row.connectedAt).toEqual(T0);

    // A reaper pass after the ORIGINAL deadline must leave it alone.
    r.clock.now = T0.getTime() + GRACE_S * 1000 + 60_000;
    const outcome = await r.reaper.reconcile();
    expect(outcome.expired).toEqual([]);
    expect(r.repo.rows.get(SID)!.state).toBe('connected');
    expect(r.cloud.terminated).toEqual([]);
  });

  it('refuses a connection once the deadline has passed', async () => {
    const r = rig();
    r.repo.seed(connectedSession());
    await r.resolver.markDisconnected(SID, 'client closed');

    r.clock.now = T0.getTime() + GRACE_S * 1000 + 1;
    (r.deps.wrapCache as InMemoryWrapTokenCache).put(SID, 'jti-late', 'wrap-late', 60);

    await expect(r.resolver.resolve(SID, 'jti-late')).resolves.toBeNull();
    await expect(r.resolver.markConnected(SID)).resolves.toBe(false);
  });
});

describe('durable grace expiry', () => {
  it('tears down through endSession: VM, credential, usage once, rental release once', async () => {
    const r = rig();
    r.repo.seed(connectedSession());
    await r.resolver.markDisconnected(SID, 'client closed');
    r.clock.now = T0.getTime() + GRACE_S * 1000 + 1;

    const outcome = await r.reaper.reconcile();

    expect(outcome.expired).toEqual([SID]);
    const row = r.repo.rows.get(SID)!;
    expect(row.state).toBe('ended');
    expect(row.endReason).toBe('idle_timeout');
    expect(r.cloud.terminated).toEqual(['i-1']);
    expect(r.revoke).toHaveBeenCalledWith(SID);
    expect([...r.usageRows.keys()]).toEqual([SID]);
    expect(r.releaseCount()).toBe(1);
    expect(r.events.record.mock.calls.filter((c) => c[1] === 'ended')).toHaveLength(1);
    expect(r.audit.record).toHaveBeenCalledTimes(1);
  });

  it('loses the race to a reconnection and terminates nothing', async () => {
    const r = rig();
    r.repo.seed(connectedSession());
    await r.resolver.markDisconnected(SID, 'client closed');

    // Reconnect wins just before the deadline…
    r.clock.now = T0.getTime() + GRACE_S * 1000 - 5;
    expect(await r.resolver.markConnected(SID)).toBe(true);

    // …then time moves past it and the reaper scans.
    r.clock.now = T0.getTime() + GRACE_S * 1000 + 1;
    const outcome = await r.reaper.reconcile();

    expect(outcome.expired).toEqual([]);
    expect(r.repo.rows.get(SID)!.state).toBe('connected');
    expect(r.cloud.terminated).toEqual([]);
    // No teardown ran: nothing was billed or released either.
    expect(r.usageRows.size).toBe(0);
    expect(r.releaseCount()).toBe(0);
    expect(r.revoke).not.toHaveBeenCalled();
  });

  it('an expiry claim that wins makes the reconnect fail closed', async () => {
    const r = rig();
    r.repo.seed(connectedSession({ state: 'disconnected', disconnectedAt: T0, disconnectDeadlineAt: new Date(T0.getTime() - 1) }));
    const now = new Date(T0.getTime());

    expect(await r.repo.claimExpiredDisconnect(SID, now)).toBe(true);
    // The session is now terminating; a late connection cannot claim it.
    await expect(r.resolver.markConnected(SID)).resolves.toBe(false);
    expect(r.repo.rows.get(SID)!.state).toBe('terminating');
  });
});

describe('security-fatal termination', () => {
  it('grants no grace: straight to terminating, deadline cleared, handles dropped', async () => {
    const r = rig();
    r.repo.seed(connectedSession());
    (r.deps.wrapCache as InMemoryWrapTokenCache).put(SID, 'jti-1', 'wrap', 60);

    await r.resolver.terminate(SID, 'connect-token replay');

    const row = r.repo.rows.get(SID)!;
    expect(row.state).toBe('terminating');
    expect(row.disconnectDeadlineAt).toBeNull();
    expect((r.deps.wrapCache as InMemoryWrapTokenCache).size()).toBe(0);
    expect(row.disconnectedAt).toEqual(T0);
  });

  it('the reaper completes the cleanup of a security-terminated session', async () => {
    const r = rig();
    r.repo.seed(connectedSession());
    await r.resolver.terminate(SID, 'protocol violation');
    r.clock.now += 1_000;

    const outcome = await r.reaper.reconcile();

    expect(outcome.recovered).toEqual([SID]);
    expect(r.repo.rows.get(SID)!.state).toBe('ended');
    expect(r.cloud.terminated).toEqual(['i-1']);
    expect(r.usageRows.size).toBe(1);
  });
});

describe('explicit end and provisioning failure', () => {
  it('ends immediately, without waiting for any grace window', async () => {
    const r = rig();
    r.repo.seed(connectedSession());

    const result = await endSession(SID, 'user', 'usr_1', r.deps);

    expect(result.state).toBe('ended');
    expect(r.repo.rows.get(SID)!.state).toBe('ended');
    expect(r.cloud.terminated).toEqual(['i-1']);
    expect(r.releaseCount()).toBe(1);
  });

  it('compensates a provisioning failure through the same teardown path', async () => {
    const r = rig();
    r.repo.seed({ id: SID, state: 'allocating', instanceId: 'pi_1', connectedAt: null });

    const result = await endSession(SID, 'error', null, r.deps);

    expect(result.state).toBe('ended');
    expect(r.repo.rows.get(SID)!.endReason).toBe('error');
    expect(r.cloud.terminated).toEqual(['i-1']);
  });
});
