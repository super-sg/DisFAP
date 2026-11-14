/**
 * Session lifecycle reaper — the durable half of the disconnect lifecycle.
 *
 * Two obligations, both driven from database state rather than from a timer
 * held by whichever process happened to see the socket close:
 *
 *  1. **Grace expiry.** A session that dropped its tunnel and did not come back
 *     before `disconnect_deadline_at` is claimed atomically
 *     (`disconnected → terminating`) and handed to the SAME `endSession`
 *     authority the HTTP route uses. Losing the claim means a reconnection won;
 *     this pass must then do nothing at all.
 *  2. **Stuck teardown recovery.** A process can die between `claimTermination`
 *     and `finalizeEnded`. Those rows sit in `terminating` with no VM cleanup.
 *     Once they are older than a retry threshold the reaper re-invokes
 *     `endSession`, whose teardown steps and usage write are idempotent, so the
 *     session converges on `ended` instead of leaking a VM.
 *
 * The reaper never touches active sessions: both queries are indexed and keyed
 * on `state` plus a deadline/timestamp.
 */

import type { SessionRepo } from '../ports.js';
import type { EndReason } from './end-session.js';

export interface LifecycleReaperLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export interface LifecycleReaperDeps {
  sessions: Pick<
    SessionRepo,
    'listDisconnectedExpired' | 'claimExpiredDisconnect' | 'listTerminatingBefore'
  >;
  /** The same full-teardown authority the HTTP route calls. */
  endSession: (sessionId: string, reason: EndReason, actor: string | null) => Promise<unknown>;
  now?: () => Date;
  /** Rows handled per pass, per category. Keeps one tick bounded. */
  batchSize?: number;
  /**
   * How long a `terminating` row may sit before a retry is safe. Long enough
   * that an in-flight teardown is never doubled by the reaper.
   */
  terminatingRetryAfterMs?: number;
  logger?: LifecycleReaperLogger;
}

export interface LifecycleReapOutcome {
  /** Sessions whose grace window expired and were fully torn down. */
  expired: string[];
  /** Stuck `terminating` sessions retried to completion. */
  recovered: string[];
  /** Sessions a teardown attempt failed for (retried next pass). */
  failed: string[];
}

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_TERMINATING_RETRY_MS = 2 * 60 * 1000;

export class SessionLifecycleReaper {
  private readonly batchSize: number;
  private readonly retryAfterMs: number;
  private readonly now: () => Date;

  constructor(private readonly deps: LifecycleReaperDeps) {
    this.batchSize = Math.max(1, deps.batchSize ?? DEFAULT_BATCH_SIZE);
    this.retryAfterMs = Math.max(0, deps.terminatingRetryAfterMs ?? DEFAULT_TERMINATING_RETRY_MS);
    this.now = deps.now ?? (() => new Date());
  }

  async reconcile(): Promise<LifecycleReapOutcome> {
    const outcome: LifecycleReapOutcome = { expired: [], recovered: [], failed: [] };
    if (
      typeof this.deps.sessions.listDisconnectedExpired !== 'function' ||
      typeof this.deps.sessions.claimExpiredDisconnect !== 'function' ||
      typeof this.deps.sessions.listTerminatingBefore !== 'function'
    ) {
      return outcome; // minimal test double: nothing durable to reconcile
    }

    const now = this.now();
    const expiredRows = await this.deps.sessions.listDisconnectedExpired(now, this.batchSize);
    for (const row of expiredRows) {
      // Reconnection may have won between the read and this claim. Only the
      // atomic winner tears the session down.
      const won = await this.deps.sessions.claimExpiredDisconnect(row.id, now);
      if (!won) continue;
      try {
        await this.deps.endSession(row.id, 'idle_timeout', null);
        outcome.expired.push(row.id);
      } catch (err) {
        outcome.failed.push(row.id);
        this.deps.logger?.warn({ sessionId: row.id, err }, 'disconnect grace teardown failed; retrying next pass');
      }
    }

    const cutoff = new Date(now.getTime() - this.retryAfterMs);
    const stuck = await this.deps.sessions.listTerminatingBefore(cutoff, this.batchSize);
    for (const row of stuck) {
      try {
        await this.deps.endSession(row.id, (row.endReason as EndReason | null) ?? 'error', null);
        outcome.recovered.push(row.id);
      } catch (err) {
        outcome.failed.push(row.id);
        this.deps.logger?.warn({ sessionId: row.id, err }, 'stuck terminating session retry failed');
      }
    }

    if (outcome.expired.length > 0 || outcome.recovered.length > 0) {
      this.deps.logger?.info(
        { expired: outcome.expired.length, recovered: outcome.recovered.length },
        'session lifecycle reaper pass completed',
      );
    }
    return outcome;
  }
}
