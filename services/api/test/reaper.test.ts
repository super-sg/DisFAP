import { describe, expect, it } from 'vitest';
import { planReconcile, Reaper, ORPHAN_GRACE_MS, type DbPoolInstance, type ReaperDb } from '../src/pool/reaper.js';
import { FakeCloudProvider, type ManagedInstance } from '../src/cloud/provider.js';

const NOW = new Date('2026-07-22T12:00:00Z');

function managed(id: string, launchedAt: Date, tags: Record<string, string> = { 'dfap:managed': 'true' }): ManagedInstance {
  return { cloudInstanceId: id, state: 'running', launchedAt, tags };
}

describe('planReconcile (pure)', () => {
  it('terminates a tracked instance whose expires_at has passed', () => {
    const cloud = [managed('i-1', new Date('2026-07-22T11:00:00Z'))];
    const db: DbPoolInstance[] = [
      { id: 'pi-1', cloudInstanceId: 'i-1', state: 'active', expiresAt: new Date('2026-07-22T11:30:00Z') },
    ];
    const plan = planReconcile(cloud, db, NOW);
    expect(plan.terminate).toEqual([{ cloudInstanceId: 'i-1', reason: 'expired', dbId: 'pi-1' }]);
  });

  it('leaves a tracked, un-expired instance alone', () => {
    const cloud = [managed('i-2', new Date('2026-07-22T11:59:00Z'))];
    const db: DbPoolInstance[] = [
      { id: 'pi-2', cloudInstanceId: 'i-2', state: 'active', expiresAt: new Date('2026-07-22T18:00:00Z') },
    ];
    expect(planReconcile(cloud, db, NOW).terminate).toEqual([]);
  });

  it('terminates an orphan (untracked, tagged) older than the grace window', () => {
    const old = new Date(NOW.getTime() - ORPHAN_GRACE_MS - 1000);
    const plan = planReconcile([managed('i-orphan', old)], [], NOW);
    expect(plan.terminate).toEqual([{ cloudInstanceId: 'i-orphan', reason: 'orphan' }]);
  });

  it('does NOT terminate a young untracked instance (still inside grace)', () => {
    const recent = new Date(NOW.getTime() - 60_000);
    expect(planReconcile([managed('i-new', recent)], [], NOW).terminate).toEqual([]);
  });

  it('does not re-terminate rows already terminating/terminated', () => {
    const cloud = [managed('i-3', new Date('2026-07-22T10:00:00Z'))];
    const db: DbPoolInstance[] = [
      { id: 'pi-3', cloudInstanceId: 'i-3', state: 'terminating', expiresAt: new Date('2026-07-22T10:30:00Z') },
    ];
    expect(planReconcile(cloud, db, NOW).terminate).toEqual([]);
  });
});

describe('Reaper.reconcile (with fakes)', () => {
  it('actually terminates an expired instance at the cloud and marks the DB row', async () => {
    const cloud = new FakeCloudProvider();
    const launched = await cloud.launchInstance({
      templateId: 'tpl_1',
      region: 'us-east-1',
      imageId: 'ami',
      instanceType: 't',
      orgId: 'org_1',
      expiresAt: new Date('2026-07-22T11:00:00Z'),
    });

    const states = new Map<string, string>([[launched.cloudInstanceId, 'active']]);
    const db: ReaperDb = {
      listActiveInstances: async () => [
        { id: 'pi-1', cloudInstanceId: launched.cloudInstanceId, state: 'active', expiresAt: new Date('2026-07-22T11:00:00Z') },
      ],
      markState: async (cloudInstanceId, state) => {
        states.set(cloudInstanceId, state);
      },
    };

    const reaper = new Reaper({ cloud, db, now: () => NOW });
    const result = await reaper.reconcile();

    expect(result.terminated).toEqual([launched.cloudInstanceId]);
    expect(cloud.isTerminated(launched.cloudInstanceId)).toBe(true);
    expect(states.get(launched.cloudInstanceId)).toBe('terminated');
    expect(result.errors).toEqual([]);
  });
});
