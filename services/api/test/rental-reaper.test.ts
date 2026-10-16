import { describe, expect, it } from 'vitest';

import {
  RentalReaper,
  planRentalReap,
  type RentalReaperStore,
} from '../src/marketplace/rental-reaper.js';
import { InMemoryMarketplaceStore, type RentalLease } from '../src/marketplace/license-store.js';
import type { EncryptedCredentialPayload } from '../src/crypto/hsm-rsa.js';

const CREDS: EncryptedCredentialPayload = {
  v: 2,
  algorithm: 'RSA-OAEP-SHA256',
  keyBits: 4096,
  keyFingerprint: 'hsm-rsa4096-test',
  cipherTextB64: 'x',
  encryptedAt: new Date().toISOString(),
};

const HOUR = 3_600_000;
const SESSION = 'ses_1';

function lease(overrides: Partial<RentalLease> = {}): RentalLease {
  return {
    rentalId: 'ren_1',
    licenseId: 'lic_1',
    sessionId: SESSION,
    leaseExpiresAt: new Date('2026-07-22T11:00:00Z'),
    ...overrides,
  };
}

describe('planRentalReap (pure)', () => {
  it('closes an expired rental whose session is terminal', () => {
    const plan = planRentalReap([lease()], new Map([[SESSION, 'ended']]), []);
    expect(plan.closeRentals).toHaveLength(1);
    expect(plan.skippedActive).toHaveLength(0);
  });

  it('closes an expired rental whose session row is gone', () => {
    const plan = planRentalReap([lease()], new Map([[SESSION, null]]), []);
    expect(plan.closeRentals).toHaveLength(1);
  });

  it('NEVER touches an expired rental whose session is still live', () => {
    for (const state of ['requested', 'allocating', 'ready', 'connected', 'idle']) {
      const plan = planRentalReap([lease()], new Map([[SESSION, state]]), []);
      expect(plan.closeRentals).toHaveLength(0);
      expect(plan.skippedActive).toHaveLength(1);
    }
  });

  it('passes abandoned claims straight through', () => {
    const plan = planRentalReap([], new Map(), ['lic_stale']);
    expect(plan.releaseClaims).toEqual(['lic_stale']);
  });

  it('holds abandoned claims whose license still has an active session', () => {
    const plan = planRentalReap([], new Map(), ['lic_active', 'lic_free'], new Set(['lic_active']));
    expect(plan.releaseClaims).toEqual(['lic_free']);
    expect(plan.heldClaims).toEqual(['lic_active']);
  });
});

/** A real in-memory store with one rented license + one open rental. */
async function rentedStore(hours = 1): Promise<{
  store: InMemoryMarketplaceStore;
  licenseId: string;
  rentalId: string;
}> {
  const store = new InMemoryMarketplaceStore();
  const lic = await store.create('owner_1', {
    softwareName: 'MATLAB & Simulink R2024b',
    version: 'R2024b',
    category: 'engineering',
    description: 'Numerical computing',
    os: 'windows',
    hourlyRateUsd: 4.5,
    templateId: 'tmpl_win_rdp',
    encryptedCredentials: CREDS,
  });
  await store.claimAvailable(lic.id, 'rentee_1');
  const rental = await store.recordRental({
    licenseId: lic.id,
    renteeId: 'rentee_1',
    sessionId: SESSION,
    hoursRequested: hours,
    totalChargedUsd: 4.5,
  });
  return { store, licenseId: lic.id, rentalId: rental.id };
}

const FUTURE = new Date(Date.now() + 2 * HOUR);

describe('RentalReaper.reconcile', () => {
  it('closes an expired rental and releases its license', async () => {
    const { store, licenseId } = await rentedStore();
    const reaper = new RentalReaper({
      store,
      sessions: { stateOf: async () => 'ended', hasActiveSessionForLicense: async () => false },
      now: () => FUTURE,
    });

    const res = await reaper.reconcile();

    expect(res.closedRentals).toHaveLength(1);
    expect(res.errors).toHaveLength(0);
    expect((await store.findById(licenseId))?.status).toBe('available');
    expect((await store.findRentalBySession(SESSION))?.endedAt).not.toBeNull();
  });

  it('leaves a live session’s rental and license completely alone', async () => {
    const { store, licenseId } = await rentedStore();
    const reaper = new RentalReaper({
      store,
      sessions: { stateOf: async () => 'ready', hasActiveSessionForLicense: async () => false },
      now: () => FUTURE,
    });

    const res = await reaper.reconcile();

    expect(res.closedRentals).toHaveLength(0);
    expect(res.skippedActive).toHaveLength(1);
    expect((await store.findById(licenseId))?.status).toBe('rented');
    expect((await store.findRentalBySession(SESSION))?.endedAt).toBeNull();
  });

  it('is idempotent — a second pass has nothing left to do', async () => {
    const { store } = await rentedStore();
    const reaper = new RentalReaper({
      store,
      sessions: { stateOf: async () => 'ended', hasActiveSessionForLicense: async () => false },
      now: () => FUTURE,
    });

    const first = await reaper.reconcile();
    const second = await reaper.reconcile();

    expect(first.closedRentals).toHaveLength(1);
    expect(second.closedRentals).toHaveLength(0);
    expect(second.releasedClaims).toHaveLength(0);
    expect(second.errors).toHaveLength(0);
  });

  it('reports a teardown failure and retries it on the next pass', async () => {
    const { store, licenseId, rentalId } = await rentedStore();
    let attempts = 0;
    const flaky: RentalReaperStore = {
      listExpiredOpenRentals: (n) => store.listExpiredOpenRentals(n),
      listStaleClaims: (o) => store.listStaleClaims(o),
      markAvailable: (id) => store.markAvailable(id),
      closeRental: async (id, at) => {
        attempts += 1;
        if (attempts === 1) throw new Error('teardown boom');
        return store.closeRental(id, at);
      },
    };
    const reaper = new RentalReaper({
      store: flaky,
      sessions: { stateOf: async () => 'ended', hasActiveSessionForLicense: async () => false },
      now: () => FUTURE,
    });

    const first = await reaper.reconcile();
    expect(first.closedRentals).toHaveLength(0);
    expect(first.errors).toEqual([{ target: rentalId, error: 'teardown boom' }]);
    expect((await store.findById(licenseId))?.status).toBe('rented');

    const second = await reaper.reconcile();
    expect(second.closedRentals).toEqual([rentalId]);
    expect((await store.findById(licenseId))?.status).toBe('available');
  });

  it('releases an abandoned claim (rented license, no open rental)', async () => {
    const store = new InMemoryMarketplaceStore();
    const lic = await store.create('owner_1', {
      softwareName: 'X',
      version: '1',
      category: 'engineering',
      description: '',
      os: 'windows',
      hourlyRateUsd: 1,
      templateId: 'tmpl_win_rdp',
      encryptedCredentials: CREDS,
    });
    await store.claimAvailable(lic.id, 'rentee_1'); // claimed, but crash before rental

    const reaper = new RentalReaper({
      store,
      sessions: { stateOf: async () => null, hasActiveSessionForLicense: async () => false },
      now: () => FUTURE,
    });

    const res = await reaper.reconcile();
    expect(res.releasedClaims).toEqual([lic.id]);
    expect((await store.findById(lic.id))?.status).toBe('available');
  });

  it('fails safe when the session-state lookup errors — never steals a license', async () => {
    const { store, licenseId } = await rentedStore();
    const reaper = new RentalReaper({
      store,
      sessions: {
        stateOf: async () => {
          throw new Error('db down');
        },
        hasActiveSessionForLicense: async () => false,
      },
      now: () => FUTURE,
    });

    const res = await reaper.reconcile();

    expect(res.closedRentals).toHaveLength(0);
    expect(res.skippedActive).toHaveLength(1);
    expect(res.errors).toEqual([{ target: SESSION, error: 'db down' }]);
    expect((await store.findById(licenseId))?.status).toBe('rented');
  });

  it('HOLDS an abandoned claim while a linked session may still be live', async () => {
    const store = new InMemoryMarketplaceStore();
    const lic = await store.create('owner_1', {
      softwareName: 'X',
      version: '1',
      category: 'engineering',
      description: '',
      os: 'windows',
      hourlyRateUsd: 1,
      templateId: 'tmpl_win_rdp',
      encryptedCredentials: CREDS,
    });
    // Claimed + session created, but the rental row never persisted.
    await store.claimAvailable(lic.id, 'rentee_1');

    const reaper = new RentalReaper({
      store,
      sessions: { stateOf: async () => null, hasActiveSessionForLicense: async (id) => id === lic.id },
      now: () => FUTURE,
    });

    const res = await reaper.reconcile();
    expect(res.releasedClaims).toEqual([]);
    expect(res.heldClaims).toEqual([lic.id]);
    expect((await store.findById(lic.id))?.status).toBe('rented');
  });

  it('releases the abandoned claim once its linked session is terminal', async () => {
    const store = new InMemoryMarketplaceStore();
    const lic = await store.create('owner_1', {
      softwareName: 'X',
      version: '1',
      category: 'engineering',
      description: '',
      os: 'windows',
      hourlyRateUsd: 1,
      templateId: 'tmpl_win_rdp',
      encryptedCredentials: CREDS,
    });
    await store.claimAvailable(lic.id, 'rentee_1');

    let active = true;
    const reaper = new RentalReaper({
      store,
      sessions: { stateOf: async () => null, hasActiveSessionForLicense: async () => active },
      now: () => FUTURE,
    });

    const held = await reaper.reconcile();
    expect(held.releasedClaims).toEqual([]);
    expect((await store.findById(lic.id))?.status).toBe('rented');

    active = false; // session confirmed terminal/absent
    const released = await reaper.reconcile();
    expect(released.releasedClaims).toEqual([lic.id]);
    expect((await store.findById(lic.id))?.status).toBe('available');
  });

  it('fails safe when the active-session lookup errors — holds the claim', async () => {
    const store = new InMemoryMarketplaceStore();
    const lic = await store.create('owner_1', {
      softwareName: 'X',
      version: '1',
      category: 'engineering',
      description: '',
      os: 'windows',
      hourlyRateUsd: 1,
      templateId: 'tmpl_win_rdp',
      encryptedCredentials: CREDS,
    });
    await store.claimAvailable(lic.id, 'rentee_1');

    const reaper = new RentalReaper({
      store,
      sessions: {
        stateOf: async () => null,
        hasActiveSessionForLicense: async () => {
          throw new Error('sessions db down');
        },
      },
      now: () => FUTURE,
    });

    const res = await reaper.reconcile();
    expect(res.releasedClaims).toEqual([]);
    expect(res.heldClaims).toEqual([lic.id]);
    expect(res.errors).toEqual([{ target: lic.id, error: 'sessions db down' }]);
    expect((await store.findById(lic.id))?.status).toBe('rented');
  });
});
