/**
 * Readiness reconciler — makes "the remote environment is ready" TRUE.
 *
 * `createSession` launches a VM but, on the real-AWS evaluation path, does NOT
 * assume it is usable: the instance is still booting, installing its desktop and
 * bringing up RDP for several minutes. Reporting `ready` at `RunInstances`
 * return time would be a fabricated success (the browser would then try to open
 * a pixel tunnel to a host that refuses connections).
 *
 * This loop closes that gap. For every session in `allocating` it:
 *   1. asks the cloud whether the instance is actually `running`,
 *   2. TCP-probes the session gateway port (RDP 3389 by default) on the
 *      instance's connect host,
 *   3. only then transitions the session `allocating → ready` and marks the pool
 *      row `active`, so the client can fetch a connect handle.
 *
 * Truthfulness guarantees:
 *  - A session is NEVER marked `ready` on a cloud state alone; the gateway port
 *    must accept a connection.
 *  - If the instance reaches a terminal cloud state, or the session overstays
 *    the readiness budget, the session is FAILED (not silently left pending),
 *    which tears down the VM and releases the rental via `failSession`.
 */

import { connect } from 'node:net';

import type { CloudProvider } from '../cloud/provider.js';
import type { InstanceRepo, SessionRepo } from '../ports.js';

export interface ReadinessLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export interface ReadinessReconcilerDeps {
  /** `allocating` sessions this loop advances. */
  sessions: Pick<SessionRepo, 'listByState' | 'update'>;
  instances: Pick<InstanceRepo, 'findConnect' | 'markState'>;
  cloud: CloudProvider;
  /**
   * Tears down a session that never became ready (terminate VM + release
   * license). Wired to the same `endSession` path the HTTP route uses so the
   * failure is compensated identically to a user-initiated end.
   */
  failSession: (sessionId: string) => Promise<unknown>;
  /** Guest gateway port the broker ultimately dials. Default 3389 (RDP). */
  probePort?: number;
  /** Per-probe connect timeout. Default 3000 ms. */
  probeTimeoutMs?: number;
  /** Budget for a session to reach `ready` before it is declared failed. */
  readyTimeoutMs?: number;
  /** Injectable TCP probe (tests). */
  probe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  now?: () => Date;
  logger?: ReadinessLogger;
}

export interface ReconcileOutcome {
  checked: number;
  ready: string[];
  failed: string[];
  waiting: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 3000;
const DEFAULT_READY_TIMEOUT_MS = 10 * 60 * 1000;

/** One-shot TCP connect probe: resolves true iff the port accepts a connection. */
export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

const TERMINAL_CLOUD_STATES = new Set(['stopping', 'stopped', 'shutting-down', 'terminated']);

export class ReadinessReconciler {
  private readonly probe: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  private readonly probePort: number;
  private readonly probeTimeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly deps: ReadinessReconcilerDeps) {
    this.probe = deps.probe ?? tcpProbe;
    this.probePort = deps.probePort ?? 3389;
    this.probeTimeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.now = deps.now ?? (() => new Date());
  }

  async reconcile(): Promise<ReconcileOutcome> {
    const outcome: ReconcileOutcome = { checked: 0, ready: [], failed: [], waiting: 0 };
    if (typeof this.deps.sessions.listByState !== 'function') return outcome;

    const allocating = await this.deps.sessions.listByState('allocating');
    const now = this.now();

    for (const session of allocating) {
      outcome.checked += 1;
      const expired = now.getTime() - session.requestedAt.getTime() > this.readyTimeoutMs;

      if (!session.instanceId) {
        if (expired) {
          await this.fail(session.id, outcome, { reason: 'no_instance' });
        } else {
          outcome.waiting += 1;
        }
        continue;
      }

      const conn =
        typeof this.deps.instances.findConnect === 'function'
          ? await this.deps.instances.findConnect(session.instanceId)
          : null;
      if (!conn) {
        if (expired) await this.fail(session.id, outcome, { reason: 'no_pool_row' });
        else outcome.waiting += 1;
        continue;
      }

      const info = this.deps.cloud.describeInstance
        ? await this.deps.cloud.describeInstance(conn.cloudInstanceId)
        : null;

      if (info && TERMINAL_CLOUD_STATES.has(info.state)) {
        await this.fail(session.id, outcome, { reason: `instance_${info.state}` });
        continue;
      }

      const host = info?.publicIp ?? conn.host ?? info?.privateIp ?? undefined;
      if (info?.state === 'running' && host && (await this.probe(host, this.probePort, this.probeTimeoutMs))) {
        await this.deps.sessions.update(session.id, { state: 'ready', readyAt: this.now() });
        await this.deps.instances.markState(session.instanceId, 'active', this.now());
        outcome.ready.push(session.id);
        this.deps.logger?.info(
          { sessionId: session.id, host, port: this.probePort, cloudInstanceId: conn.cloudInstanceId },
          'session ready: cloud running + gateway reachable',
        );
        continue;
      }

      if (expired) {
        await this.fail(session.id, outcome, { reason: 'readiness_timeout' });
      } else {
        outcome.waiting += 1;
      }
    }

    return outcome;
  }

  private async fail(sessionId: string, outcome: ReconcileOutcome, detail: Record<string, unknown>): Promise<void> {
    try {
      await this.deps.failSession(sessionId);
      outcome.failed.push(sessionId);
      this.deps.logger?.warn({ sessionId, ...detail }, 'session failed readiness; tear-down requested');
    } catch (err) {
      // Leave the session recoverable (still `allocating`) for the next pass;
      // the hard `pool_instances.expires_at` + reaper remain the backstop.
      this.deps.logger?.warn({ sessionId, err, ...detail }, 'readiness failure tear-down itself failed');
    }
  }
}
