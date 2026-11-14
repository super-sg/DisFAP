import { describe, it, expect, vi } from 'vitest';

import { ReadinessReconciler, tcpProbe } from '../src/pool/readiness.js';
import type { CloudInstanceInfo, CloudProvider } from '../src/cloud/provider.js';
import type { SessionRecord } from '../src/ports.js';

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'ses_1',
    orgId: 'org_1',
    userId: 'usr_1',
    templateId: 'tmpl_linux_dev',
    instanceId: 'inst_1',
    licenseId: 'lic_1',
    state: 'allocating',
    requestedAt: new Date('2026-10-16T00:00:00Z'),
    readyAt: null,
    firstPixelAt: null,
    connectedAt: null,
    disconnectedAt: null,
    disconnectDeadlineAt: null,
    endedAt: null,
    endReason: null,
    billableSeconds: null,
    vaultCredPath: 'secret/sessions/ses_1/rdp',
    clientIp: null,
    clientUa: null,
    ...overrides,
  };
}

interface Harness {
  reconciler: ReadinessReconciler;
  update: ReturnType<typeof vi.fn>;
  markState: ReturnType<typeof vi.fn>;
  markConnectHost: ReturnType<typeof vi.fn>;
  failSession: ReturnType<typeof vi.fn>;
  info: CloudInstanceInfo | null;
  probeResult: boolean;
}

function harness(opts: {
  rows: SessionRecord[];
  info?: CloudInstanceInfo | null;
  host?: string | null;
  probeResult?: boolean;
  now?: Date;
  readyTimeoutMs?: number;
}): Harness {
  const update = vi.fn(async (id: string, patch: Record<string, unknown>) => session({ id, ...patch }));
  const markState = vi.fn(async () => undefined);
  const markConnectHost = vi.fn(async () => undefined);
  const failSession = vi.fn(async () => undefined);

  const state = {
    info: opts.info === undefined ? { state: 'running' as const, publicIp: '203.0.113.9' } : opts.info,
    probeResult: opts.probeResult ?? true,
  };

  const cloud = {
    launchInstance: vi.fn(),
    terminateInstance: vi.fn(),
    describeManaged: vi.fn(async () => []),
    describeInstance: vi.fn(async () => state.info),
  } as unknown as CloudProvider;

  const reconciler = new ReadinessReconciler({
    sessions: {
      listByState: async () => opts.rows,
      update: update as never,
    },
    instances: {
      findConnect: async () => ({ cloudInstanceId: 'i-1', host: opts.host === undefined ? '203.0.113.9' : opts.host }),
      markState: markState as never,
      markConnectHost: markConnectHost as never,
    },
    cloud,
    failSession: failSession as never,
    probe: async () => state.probeResult,
    now: () => opts.now ?? new Date('2026-10-16T00:01:00Z'),
    ...(opts.readyTimeoutMs !== undefined ? { readyTimeoutMs: opts.readyTimeoutMs } : {}),
  });

  return { reconciler, update, markState, markConnectHost, failSession, info: state.info, probeResult: state.probeResult };
}

describe('ReadinessReconciler', () => {
  it('promotes a session to ready only when the cloud reports running AND the port is open', async () => {
    const h = harness({ rows: [session()], probeResult: true });
    const out = await h.reconciler.reconcile();
    expect(out.ready).toEqual(['ses_1']);
    expect(h.update).toHaveBeenCalledWith('ses_1', expect.objectContaining({ state: 'ready' }));
    expect(h.markState).toHaveBeenCalledWith('inst_1', 'active', expect.any(Date));
    expect(h.failSession).not.toHaveBeenCalled();
  });

  it('records the reachable host when the stored one is stale (public IP learned late)', async () => {
    // RunInstances often omits the public IP while the instance is pending, so
    // the pool row falls back to the private IP — unreachable for a broker
    // outside the VPC. The probe reaches the public IP the cloud reports, and
    // that verified host must be persisted so the broker dials the right place.
    const h = harness({
      rows: [session()],
      host: '10.0.0.5',
      info: { state: 'running', publicIp: '203.0.113.9' },
    });
    const out = await h.reconciler.reconcile();
    expect(out.ready).toEqual(['ses_1']);
    expect(h.markConnectHost).toHaveBeenCalledWith('inst_1', '203.0.113.9');
  });

  it('does not rewrite the connect host when it already matches', async () => {
    const h = harness({ rows: [session()] });
    await h.reconciler.reconcile();
    expect(h.markConnectHost).not.toHaveBeenCalled();
  });

  it('does NOT promote while the gateway port is still closed', async () => {
    const h = harness({ rows: [session()], probeResult: false });
    const out = await h.reconciler.reconcile();
    expect(out.ready).toEqual([]);
    expect(out.waiting).toBe(1);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('does NOT promote while the instance is not yet running', async () => {
    const h = harness({ rows: [session()], info: { state: 'pending' }, probeResult: true });
    const out = await h.reconciler.reconcile();
    expect(out.ready).toEqual([]);
    expect(out.waiting).toBe(1);
  });

  it('fails a session whose instance reached a terminal cloud state', async () => {
    const h = harness({ rows: [session()], info: { state: 'terminated' } });
    const out = await h.reconciler.reconcile();
    expect(out.failed).toEqual(['ses_1']);
    expect(h.failSession).toHaveBeenCalledWith('ses_1');
    expect(h.update).not.toHaveBeenCalled();
  });

  it('fails a session that overstays the readiness budget', async () => {
    const h = harness({
      rows: [session({ requestedAt: new Date('2026-10-16T00:00:00Z') })],
      probeResult: false,
      now: new Date('2026-10-16T01:00:00Z'),
      readyTimeoutMs: 600_000,
    });
    const out = await h.reconciler.reconcile();
    expect(out.failed).toEqual(['ses_1']);
    expect(h.failSession).toHaveBeenCalledWith('ses_1');
  });

  it('waits (never fails early) for a session with no instance yet, before the budget', async () => {
    const h = harness({ rows: [session({ instanceId: null })], now: new Date('2026-10-16T00:01:00Z') });
    const out = await h.reconciler.reconcile();
    expect(out.waiting).toBe(1);
    expect(h.failSession).not.toHaveBeenCalled();
  });

  it('fails a session with no instance once past the budget', async () => {
    const h = harness({
      rows: [session({ instanceId: null })],
      now: new Date('2026-10-16T01:00:00Z'),
      readyTimeoutMs: 600_000,
    });
    const out = await h.reconciler.reconcile();
    expect(out.failed).toEqual(['ses_1']);
    expect(h.failSession).toHaveBeenCalledWith('ses_1');
  });

  it('is a no-op when the repo cannot list sessions', async () => {
    const reconciler = new ReadinessReconciler({
      sessions: { update: vi.fn() as never },
      instances: { findConnect: vi.fn() as never, markState: vi.fn() as never },
      cloud: {} as CloudProvider,
      failSession: vi.fn() as never,
    });
    const out = await reconciler.reconcile();
    expect(out).toEqual({ checked: 0, ready: [], failed: [], waiting: 0 });
  });

  it('isolates a failing session so the rest of the pass still runs', async () => {
    // A throttled DescribeInstances — or a transient database error on a single
    // row — must not stall every other pending session. Each row is reconciled
    // inside its own try/catch and simply retried on the next pass.
    const update = vi.fn(async (id: string, patch: Record<string, unknown>) => session({ id, ...patch }));
    const failSession = vi.fn(async () => undefined);
    let calls = 0;

    const reconciler = new ReadinessReconciler({
      sessions: {
        listByState: async () => [session({ id: 'ses_bad' }), session({ id: 'ses_good' })],
        update: update as never,
      },
      instances: {
        findConnect: async () => ({ cloudInstanceId: 'i-1', host: '203.0.113.9' }),
        markState: vi.fn(async () => undefined) as never,
      },
      cloud: {
        launchInstance: vi.fn(),
        terminateInstance: vi.fn(),
        describeManaged: vi.fn(async () => []),
        describeInstance: vi.fn(async () => {
          calls += 1;
          if (calls === 1) {
            throw Object.assign(new Error('rate exceeded'), { name: 'Throttling' });
          }
          return { state: 'running' as const, publicIp: '203.0.113.9' };
        }),
      } as unknown as CloudProvider,
      failSession: failSession as never,
      probe: async () => true,
      now: () => new Date('2026-10-16T00:01:00Z'),
    });

    const out = await reconciler.reconcile();

    expect(out.checked).toBe(2);
    expect(out.ready).toEqual(['ses_good']);
    expect(out.waiting).toBe(1);
    // The blip is not a session failure: it stays `allocating` and retries.
    expect(failSession).not.toHaveBeenCalled();
  });
});

describe('tcpProbe', () => {
  it('returns false for a closed port instead of throwing', async () => {
    // Port 1 on loopback is never listening.
    await expect(tcpProbe('127.0.0.1', 1, 200)).resolves.toBe(false);
  });
});
