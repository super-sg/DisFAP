/**
 * In-memory `SessionRepo` used by lifecycle tests.
 *
 * It models the SAME concurrency contract as the Prisma adapter: every
 * lifecycle mutation is a synchronous compare-and-set executed in the method
 * body, so two awaited callers cannot both "win". That is what lets the tests
 * assert the reconnect-versus-reaper race without a database.
 */

import type {
  CreateSessionData,
  SessionPatch,
  SessionRecord,
  SessionRepo,
} from '../../src/ports.js';
import type { SessionState } from '../../src/state-machine.js';

const CLAIMABLE: ReadonlySet<SessionState> = new Set<SessionState>([
  'requested',
  'allocating',
  'ready',
  'connected',
  'idle',
  'disconnected',
]);

export class FakeSessionRepo implements SessionRepo {
  readonly rows = new Map<string, SessionRecord>();
  private seq = 0;
  /** Count of finalize attempts that actually performed the transition. */
  readonly finalizations: string[] = [];
  /** When set, the next `finalizeEnded` rejects (simulates a crash mid-teardown). */
  failNextFinalize = false;

  constructor(private readonly now: () => Date = () => new Date()) {}

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
      requestedAt: this.now(),
      readyAt: null,
      firstPixelAt: null,
      connectedAt: null,
      disconnectedAt: null,
      disconnectDeadlineAt: null,
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
    if (!row) throw new Error(`no such session ${id}`);
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

  // ── atomic teardown primitives ────────────────────────────────────────────

  async claimTermination(id: string, at: Date): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || !CLAIMABLE.has(row.state)) return false;
    row.state = 'terminating';
    row.disconnectedAt ??= at;
    row.disconnectDeadlineAt = null;
    return true;
  }

  async finalizeEnded(id: string, patch: SessionPatch): Promise<boolean> {
    if (this.failNextFinalize) {
      this.failNextFinalize = false;
      throw new Error('simulated crash before finalize');
    }
    const row = this.rows.get(id);
    if (!row || row.state !== 'terminating') return false;
    Object.assign(row, patch);
    this.finalizations.push(id);
    return true;
  }

  // ── reaper queries ────────────────────────────────────────────────────────

  async listDisconnectedExpired(now: Date, limit: number): Promise<SessionRecord[]> {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.state === 'disconnected' &&
          r.disconnectDeadlineAt !== null &&
          r.disconnectDeadlineAt.getTime() <= now.getTime(),
      )
      .sort((a, b) => (a.disconnectDeadlineAt!.getTime() - b.disconnectDeadlineAt!.getTime()))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async claimExpiredDisconnect(id: string, now: Date): Promise<boolean> {
    const row = this.rows.get(id);
    if (
      !row ||
      row.state !== 'disconnected' ||
      row.disconnectDeadlineAt === null ||
      row.disconnectDeadlineAt.getTime() > now.getTime()
    ) {
      return false;
    }
    row.state = 'terminating';
    row.disconnectDeadlineAt = null;
    return true;
  }

  async listTerminatingBefore(cutoff: Date, limit: number): Promise<SessionRecord[]> {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.state === 'terminating' &&
          r.disconnectedAt !== null &&
          r.disconnectedAt.getTime() <= cutoff.getTime(),
      )
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** Insert a fully-formed row directly (bypasses the create path). */
  seed(row: Partial<SessionRecord> & { id: string }): SessionRecord {
    const base: SessionRecord = {
      orgId: 'org_1',
      userId: 'usr_1',
      templateId: 'tpl_1',
      instanceId: 'pi_1',
      licenseId: null,
      state: 'connected',
      requestedAt: this.now(),
      readyAt: this.now(),
      firstPixelAt: this.now(),
      connectedAt: this.now(),
      disconnectedAt: null,
      disconnectDeadlineAt: null,
      endedAt: null,
      endReason: null,
      billableSeconds: null,
      vaultCredPath: `sessions/${row.id}/rdp`,
      clientIp: null,
      clientUa: null,
      ...row,
    };
    this.rows.set(base.id, base);
    return { ...base };
  }
}
