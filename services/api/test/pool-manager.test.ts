import { describe, expect, it, vi } from 'vitest';
import { PoolManager, type PoolInstanceRow, type PoolManagerDb, type PoolLaunchPlanner } from '../src/pool/pool-manager.js';
import { FakeCloudProvider } from '../src/cloud/provider.js';
import { OfflineImageInjector, PREBOOT_MARKER, deriveImageWrapKey } from '../src/cloud/disk-injector.js';

function warmRow(overrides: Partial<PoolInstanceRow> = {}): PoolInstanceRow {
  return {
    id: 'pi_warm',
    cloud_instance_id: 'i-warm-1',
    template_id: 'tpl_1',
    region: 'us-east-1',
    az: 'us-east-1a',
    private_ip: '10.0.0.5',
    state: 'claimed',
    expires_at: new Date('2026-07-22T10:00:00Z'),
    hourly_cost_usd: '0.0168',
    ...overrides,
  };
}

const planner: PoolLaunchPlanner = {
  plan: async (templateId, sessionId) => ({
    spec: {
      templateId,
      region: 'us-east-1',
      imageId: 'ami-test',
      instanceType: 't4g.small',
      sessionId,
      orgId: 'org_1',
      expiresAt: new Date('2026-07-22T18:00:00Z'),
    },
    hourlyCostUsd: 0.0168,
  }),
};

describe('PoolManager.claim', () => {
  it('claims a warm instance via the raw FOR UPDATE SKIP LOCKED query (no cold launch)', async () => {
    const row = warmRow();
    const $queryRawUnsafe = vi.fn().mockResolvedValue([row]);
    const create = vi.fn();
    const db: PoolManagerDb = { $queryRawUnsafe, poolInstance: { create } };
    const cloud = new FakeCloudProvider();
    const launchSpy = vi.spyOn(cloud, 'launchInstance');

    const mgr = new PoolManager({ db, cloud, planner });
    const result = await mgr.claim('tpl_1', 'ses_42');

    // The raw claim ran with (sessionId, templateId) params, in that order.
    expect($queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, ...params] = $queryRawUnsafe.mock.calls[0]!;
    expect(String(sql)).toContain('FOR UPDATE SKIP LOCKED');
    expect(params).toEqual(['ses_42', 'tpl_1']);

    expect(result.coldLaunched).toBe(false);
    expect(result.instance.cloudInstanceId).toBe('i-warm-1');
    expect(result.instance.hourlyCostUsd).toBeCloseTo(0.0168);
    // Warm hit => no VM launched, no row inserted.
    expect(launchSpy).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('cold-launches when the warm pool is empty and inserts a provisioning row', async () => {
    const $queryRawUnsafe = vi.fn().mockResolvedValue([]); // empty pool
    const created = warmRow({ id: 'pi_cold', cloud_instance_id: 'i-fake-1', state: 'provisioning' });
    const create = vi.fn().mockResolvedValue(created);
    const db: PoolManagerDb = { $queryRawUnsafe, poolInstance: { create } };
    const cloud = new FakeCloudProvider();

    const mgr = new PoolManager({ db, cloud, planner });
    const result = await mgr.claim('tpl_1', 'ses_99');

    expect(result.coldLaunched).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data['state']).toBe('provisioning');
    expect(data['templateId']).toBe('tpl_1');
    expect(data['claimedBySessionId']).toBe('ses_99');
    // Every instance carries a hard expires_at from creation.
    expect(data['expiresAt']).toBeInstanceOf(Date);
    expect(result.instance.cloudInstanceId).toBe('i-fake-1');
  });
});

describe('PoolManager pre-boot credential injection (spec step 5)', () => {
  function coldDb(): { db: PoolManagerDb; create: ReturnType<typeof vi.fn> } {
    const $queryRawUnsafe = vi.fn().mockResolvedValue([]);
    const create = vi
      .fn()
      .mockResolvedValue(warmRow({ id: 'pi_cold', cloud_instance_id: 'i-fake-1', state: 'provisioning' }));
    return { db: { $queryRawUnsafe, poolInstance: { create } }, create };
  }

  it('writes the sealed credential onto the VM before RunInstances (cold path)', async () => {
    const { db } = coldDb();
    const cloud = new FakeCloudProvider();
    const launchSpy = vi.spyOn(cloud, 'launchInstance');
    const injector = new OfflineImageInjector(deriveImageWrapKey(Buffer.alloc(32, 1)));

    const prepareSpy = vi.spyOn(injector, 'prepare');
    const mgr = new PoolManager({ db, cloud, planner, injector });

    await mgr.claim('tpl_1', 'ses_preboot', { username: 'dfap-admin', password: 'S3cret!' });

    // Injection happened, and it happened before the launch call.
    expect(prepareSpy).toHaveBeenCalledTimes(1);
    expect(launchSpy).toHaveBeenCalledTimes(1);
    const spec = launchSpy.mock.calls[0]![0];
    expect(spec.userData).toContain(PREBOOT_MARKER);
    expect(spec.userData).not.toContain('S3cret!');
  });

  it('does not inject when no credential is supplied', async () => {
    const { db } = coldDb();
    const cloud = new FakeCloudProvider();
    const launchSpy = vi.spyOn(cloud, 'launchInstance');
    const injector = new OfflineImageInjector(deriveImageWrapKey(Buffer.alloc(32, 1)));
    const prepareSpy = vi.spyOn(injector, 'prepare');

    const mgr = new PoolManager({ db, cloud, planner, injector });
    await mgr.claim('tpl_1', 'ses_plain');

    expect(prepareSpy).not.toHaveBeenCalled();
    expect(launchSpy.mock.calls[0]![0].userData).toBeUndefined();
  });

  it('skips injection on a warm hit (instance booted before the credential existed)', async () => {
    const row = warmRow();
    const $queryRawUnsafe = vi.fn().mockResolvedValue([row]);
    const db: PoolManagerDb = { $queryRawUnsafe, poolInstance: { create: vi.fn() } };
    const cloud = new FakeCloudProvider();
    const injector = new OfflineImageInjector(deriveImageWrapKey(Buffer.alloc(32, 1)));
    const prepareSpy = vi.spyOn(injector, 'prepare');

    const mgr = new PoolManager({ db, cloud, planner, injector });
    const result = await mgr.claim('tpl_1', 'ses_warm', { username: 'u', password: 'p' });

    expect(result.coldLaunched).toBe(false);
    expect(prepareSpy).not.toHaveBeenCalled();
  });
});
