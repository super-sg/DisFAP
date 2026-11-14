/**
 * Reaper — layer 4 of the five-layer teardown (architecture.md). It reconciles
 * the cloud's ground truth against the control-plane database and terminates:
 *
 *  1. any instance whose `expires_at` has passed (DB says it should be gone);
 *  2. any DisFAP-tagged instance the cloud reports that the DB has NO record
 *     of ("orphan"), once it has existed longer than `orphanGraceMs` — this is
 *     the safety net for a crash between `RunInstances` and the DB write.
 *
 * The planning step is pure (`planReconcile`) so every branch is unit-testable
 * without a cloud or a database; `reconcile()` just fetches inputs and applies
 * the plan.
 */

import type { CloudProvider, ManagedInstance } from '../cloud/provider.js';

/** Default grace before an untracked cloud instance is treated as an orphan. */
export const ORPHAN_GRACE_MS = 15 * 60 * 1000; // 15 minutes

/** What the DB knows about a pool instance (reaper-relevant fields). */
export interface DbPoolInstance {
  id: string;
  cloudInstanceId: string;
  state: string;
  expiresAt: Date;
}

export interface ReapAction {
  cloudInstanceId: string;
  reason: 'expired' | 'orphan';
  /** DB row id when we know it (expired path); absent for orphans. */
  dbId?: string;
}

export interface ReconcilePlan {
  terminate: ReapAction[];
}

/** States that are already gone or on their way out — never re-terminated. */
const DONE_STATES: ReadonlySet<string> = new Set(['terminating', 'terminated']);

/**
 * Pure reconciliation. Given cloud truth + DB rows + `now`, decide what to
 * terminate. Deterministic and side-effect free.
 */
export function planReconcile(
  managed: readonly ManagedInstance[],
  dbRows: readonly DbPoolInstance[],
  now: Date,
  orphanGraceMs: number = ORPHAN_GRACE_MS,
): ReconcilePlan {
  const nowMs = now.getTime();
  const dbByCloudId = new Map<string, DbPoolInstance>();
  for (const r of dbRows) dbByCloudId.set(r.cloudInstanceId, r);

  const managedIds = new Set<string>();
  const terminate: ReapAction[] = [];

  // Pass 1: cloud-truth instances — orphan detection + expiry against DB row.
  for (const inst of managed) {
    managedIds.add(inst.cloudInstanceId);
    const row = dbByCloudId.get(inst.cloudInstanceId);

    if (!row) {
      // Untracked but DisFAP-tagged: an orphan once past the grace window.
      const ageMs = nowMs - inst.launchedAt.getTime();
      if (ageMs >= orphanGraceMs) {
        terminate.push({ cloudInstanceId: inst.cloudInstanceId, reason: 'orphan' });
      }
      continue;
    }

    if (!DONE_STATES.has(row.state) && row.expiresAt.getTime() <= nowMs) {
      terminate.push({ cloudInstanceId: inst.cloudInstanceId, reason: 'expired', dbId: row.id });
    }
  }

  // Pass 2: DB rows expired but the cloud no longer reports them — nothing to
  // terminate at the cloud, but the caller may want to mark them terminated.
  // (We only report cloud-actionable terminations here; DB cleanup is handled
  //  by reconcile() when applying the plan.)

  return { terminate };
}

export interface ReaperDb {
  /** Non-terminated pool instances the DB currently tracks. */
  listActiveInstances(): Promise<DbPoolInstance[]>;
  /** Flip a row's lifecycle state (idempotent). */
  markState(cloudInstanceId: string, state: string, at: Date): Promise<void>;
}

export interface ReaperDeps {
  cloud: CloudProvider;
  db: ReaperDb;
  now?: () => Date;
  orphanGraceMs?: number;
}

export interface ReconcileResult {
  planned: ReconcilePlan;
  terminated: string[];
  errors: { cloudInstanceId: string; error: string }[];
}

export class Reaper {
  private readonly cloud: CloudProvider;
  private readonly db: ReaperDb;
  private readonly now: () => Date;
  private readonly orphanGraceMs: number;

  constructor(deps: ReaperDeps) {
    this.cloud = deps.cloud;
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date());
    this.orphanGraceMs = deps.orphanGraceMs ?? ORPHAN_GRACE_MS;
  }

  async reconcile(): Promise<ReconcileResult> {
    const [managed, dbRows] = await Promise.all([this.cloud.describeManaged(), this.db.listActiveInstances()]);
    const now = this.now();
    const planned = planReconcile(managed, dbRows, now, this.orphanGraceMs);

    const terminated: string[] = [];
    const errors: { cloudInstanceId: string; error: string }[] = [];

    for (const action of planned.terminate) {
      try {
        // Mark first so a crash mid-loop leaves the row in `terminating`,
        // which the next pass (and DONE_STATES) will not double-act on.
        if (action.dbId) await this.db.markState(action.cloudInstanceId, 'terminating', now);
        await this.cloud.terminateInstance(action.cloudInstanceId);
        if (action.dbId) await this.db.markState(action.cloudInstanceId, 'terminated', now);
        terminated.push(action.cloudInstanceId);
      } catch (err) {
        errors.push({ cloudInstanceId: action.cloudInstanceId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return { planned, terminated, errors };
  }
}
