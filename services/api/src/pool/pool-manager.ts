/**
 * Pool manager — claims a VM for a session (ADR-001).
 *
 * Claim is race-free across concurrent API nodes: a single SQL statement
 * atomically selects one `warm` instance and flips it to `claimed`, using
 * `FOR UPDATE SKIP LOCKED` so two claimers never contend for the same row and
 * never block each other — the loser simply skips to the next free instance.
 *
 * SIZING NOTE (warm pool): a steady-state warm count of
 *     ceil( arrivalRate[/s] * warmupSeconds ) + headroom
 * keeps p95 time-to-session at the warm tier (~35-60s) instead of cold
 * (~45-110s). Because instances are burn-after-reading (ADR-004) the pool
 * drains one-way, so a background filler must top it up. **Phase-0 keeps the
 * pool empty and every claim cold-launches** — the raw claim below still runs
 * (returns zero rows) and we always fall through to `RunInstances`.
 */

import type { CloudProvider, LaunchSpec } from '../cloud/provider.js';
import type { PreBootCredential, PreBootInjector } from '../cloud/disk-injector.js';

/** Row shape returned by the claim query / instance insert (subset we use). */
export interface PoolInstanceRow {
  id: string;
  cloud_instance_id: string;
  template_id: string;
  region: string;
  az: string;
  private_ip: string | null;
  state: string;
  expires_at: Date;
  hourly_cost_usd: unknown; // Prisma Decimal | number | string depending on driver
}

/** Normalized result the rest of the control plane consumes. */
export interface ClaimedInstance {
  id: string;
  cloudInstanceId: string;
  templateId: string;
  region: string;
  az: string;
  privateIp: string | null;
  state: string;
  expiresAt: Date;
  hourlyCostUsd: number;
}

export interface ClaimResult {
  instance: ClaimedInstance;
  /** True when the warm pool was empty and we launched a fresh VM. */
  coldLaunched: boolean;
}

/**
 * Minimal slice of `PrismaClient` the manager needs. `PrismaClient` satisfies
 * this structurally; tests pass a fake that mocks `$queryRawUnsafe`.
 */
export interface PoolManagerDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  poolInstance: {
    // Only the id is consumed on the cold path; the rest of the row is known
    // from the launch spec, so we don't depend on the create result's casing.
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
}

/** Turns a template into a concrete launch spec + its hourly cost. */
export interface PoolLaunchPlanner {
  plan(templateId: string, sessionId: string): Promise<{ spec: LaunchSpec; hourlyCostUsd: number }>;
}

/**
 * The claim statement. Selecting the inner row `FOR UPDATE SKIP LOCKED` and
 * updating by that id is the canonical Postgres work-queue pattern: exactly
 * one concurrent caller wins each warm row, and none block.
 */
const CLAIM_SQL = `
UPDATE pool_instances
   SET state = 'claimed',
       claimed_by_session_id = $1,
       claimed_at = now()
 WHERE id = (
   SELECT id
     FROM pool_instances
    WHERE template_id = $2
      AND state = 'warm'
      AND expires_at > now()
    ORDER BY ready_at ASC NULLS LAST
    LIMIT 1
    FOR UPDATE SKIP LOCKED
 )
RETURNING id, cloud_instance_id, template_id, region, az, private_ip, state, expires_at, hourly_cost_usd;
`;

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  if (v != null && typeof (v as { toString?: () => string }).toString === 'function') {
    return Number((v as { toString: () => string }).toString());
  }
  return 0;
}

function normalize(row: PoolInstanceRow): ClaimedInstance {
  return {
    id: row.id,
    cloudInstanceId: row.cloud_instance_id,
    templateId: row.template_id,
    region: row.region,
    az: row.az,
    privateIp: row.private_ip,
    state: row.state,
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at as string),
    hourlyCostUsd: toNumber(row.hourly_cost_usd),
  };
}

export interface PoolManagerDeps {
  db: PoolManagerDb;
  cloud: CloudProvider;
  planner: PoolLaunchPlanner;
  /** Writes the login material onto the VM's disk before first boot. */
  injector?: PreBootInjector;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export class PoolManager {
  private readonly db: PoolManagerDb;
  private readonly cloud: CloudProvider;
  private readonly planner: PoolLaunchPlanner;
  private readonly injector: PreBootInjector | undefined;
  private readonly now: () => Date;

  constructor(deps: PoolManagerDeps) {
    this.db = deps.db;
    this.cloud = deps.cloud;
    this.planner = deps.planner;
    this.injector = deps.injector;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Claim an instance for `sessionId` from `templateId`'s warm pool, or
   * cold-launch one if the pool is empty. Every instance we create carries an
   * `expires_at` from the start so the reaper can always bound its lifetime.
   *
   * When `preBoot` is provided and an injector is configured, the credential
   * is written onto the new VM's disk before `RunInstances` fires — the
   * spec's "credentials before boot" guarantee (see cloud/disk-injector.ts).
   */
  async claim(templateId: string, sessionId: string, preBoot?: PreBootCredential | undefined): Promise<ClaimResult> {
    const claimed = await this.db.$queryRawUnsafe<PoolInstanceRow[]>(CLAIM_SQL, sessionId, templateId);
    if (claimed.length > 0) {
      return { instance: normalize(claimed[0]!), coldLaunched: false };
    }

    // Cold path (the only path in Phase-0): launch a fresh VM.
    const { spec: plannedSpec, hourlyCostUsd } = await this.planner.plan(templateId, sessionId);

    // Pre-boot injection (spec "Working Explanation" step 5): the credential
    // is written onto the VM's disk BEFORE the hypervisor boots it. Applies
    // only on the cold path — a warm instance booted long before this
    // credential existed, and is fed via Vault at connect time instead.
    let spec = plannedSpec;
    if (preBoot && this.injector) {
      const injection = await this.injector.prepare(spec, preBoot);
      if (injection.userData !== undefined) {
        spec = { ...spec, userData: injection.userData };
      }
    }

    const launched = await this.cloud.launchInstance(spec);

    const created = await this.db.poolInstance.create({
      data: {
        templateId,
        region: spec.region,
        az: launched.az,
        cloudInstanceId: launched.cloudInstanceId,
        // The connect host the broker dials. In-VPC deployments reach the
        // instance's private IP, but the local evaluation topology runs the
        // control plane OUTSIDE the VPC, so a public IP (when the instance has
        // one) is the only reachable address. Prefer it when present.
        privateIp: launched.publicIp ?? launched.privateIp ?? null,
        state: 'provisioning',
        claimedBySessionId: sessionId,
        ...(spec.securityGroupId !== undefined ? { securityGroupId: spec.securityGroupId } : {}),
        launchedAt: launched.launchedAt,
        claimedAt: this.now(),
        // Hard deadline stamped at creation — mirrors the dfap:expires_at tag.
        expiresAt: spec.expiresAt,
        hourlyCostUsd,
      },
    });

    // Build from the launch spec + created id (not the create result's fields),
    // so ORM field-casing never matters here.
    const instance: ClaimedInstance = {
      id: created.id,
      cloudInstanceId: launched.cloudInstanceId,
      templateId,
      region: spec.region,
      az: launched.az,
      privateIp: launched.publicIp ?? launched.privateIp ?? null,
      state: 'provisioning',
      expiresAt: spec.expiresAt,
      hourlyCostUsd,
    };
    return { instance, coldLaunched: true };
  }
}
