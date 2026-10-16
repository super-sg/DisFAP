import { describe, expect, it } from 'vitest';

import { InMemoryMarketplaceStore } from '../src/marketplace/license-store.js';
import { RentalReaper, type RentalReaperStore } from '../src/marketplace/rental-reaper.js';
import { withRetries } from '../src/util/retry.js';
import type { EncryptedCredentialPayload } from '../src/crypto/hsm-rsa.js';
import type { PairEncryptedPayload } from '../src/crypto/pair-keys.js';

const FIXED = new Date('2026-07-22T12:00:00Z');

const CREDS: EncryptedCredentialPayload = {
  v: 2,
  algorithm: 'RSA-OAEP-SHA256',
  keyBits: 4096,
  keyFingerprint: 'kid',
  cipherTextB64: 'x',
  encryptedAt: FIXED.toISOString(),
};

const PAIR: PairEncryptedPayload = { v: 1, alg: 'AES-256-GCM-HKDF', iv: 'a', tag: 'b', ct: 'c', pair: 'd' };

async function seededStore(): Promise<InMemoryMarketplaceStore> {
  const store = new InMemoryMarketplaceStore();
  await store.create('owner_1', {
    softwareName: 'MATLAB & Simulink R2024b',
    version: 'R2024b',
    category: 'engineering',
    description: '',
    os: 'windows',
    hourlyRateUsd: 4.5,
    templateId: 'tmpl_win_rdp',
    encryptedCredentials: CREDS,
  });
  return store;
}

describe('pair payload lifecycle — dropped when a rental ends', () => {
  it('clears the pair payload when the rental completes (and stays cleared)', async () => {
    const store = await seededStore();
    const lic = (await store.listAvailable())[0]!;
    await store.claimAvailable(lic.id, 'rentee_1');
    const rental = await store.recordRental({
      licenseId: lic.id,
      renteeId: 'rentee_1',
      sessionId: 'ses_1',
      hoursRequested: 1,
      totalChargedUsd: 4.5,
      pairPayload: PAIR,
    });
    expect(rental.pairPayload).toEqual(PAIR);

    await store.completeForSession('ses_1');
    expect((await store.findRentalBySession('ses_1'))?.pairPayload).toBeUndefined();

    // Idempotent: closing again does not resurrect or error.
    await store.completeForSession('ses_1');
    expect((await store.findRentalBySession('ses_1'))?.pairPayload).toBeUndefined();
  });

  it('clears the pair payload on closeRental too', async () => {
    const store = await seededStore();
    const lic = (await store.listAvailable())[0]!;
    await store.claimAvailable(lic.id, 'rentee_1');
    const rental = await store.recordRental({
      licenseId: lic.id,
      renteeId: 'rentee_1',
      sessionId: 'ses_2',
      hoursRequested: 1,
      totalChargedUsd: 4.5,
      pairPayload: PAIR,
    });

    await store.closeRental(rental.id, FIXED);
    expect((await store.findRentalBySession('ses_2'))?.pairPayload).toBeUndefined();
  });

  it('the cleanup sweep drops a stale payload on an ended rental, idempotently', async () => {
    const store = await seededStore();
    const lic = (await store.listAvailable())[0]!;
    await store.claimAvailable(lic.id, 'rentee_1');
    const rental = await store.recordRental({
      licenseId: lic.id,
      renteeId: 'rentee_1',
      sessionId: 'ses_3',
      hoursRequested: 1,
      totalChargedUsd: 4.5,
      pairPayload: PAIR,
    });

    // An open rental is not stale.
    expect(await store.clearStalePairPayloads(FIXED)).toBe(0);

    // Simulate an ended-but-not-cleared row (e.g. an inline clear that failed).
    rental.endedAt = FIXED.toISOString();
    expect(await store.clearStalePairPayloads(FIXED)).toBe(1);
    expect(rental.pairPayload).toBeUndefined();
    expect(await store.clearStalePairPayloads(FIXED)).toBe(0);
  });
});

function reaperStore(overrides: Partial<RentalReaperStore> = {}): RentalReaperStore {
  return {
    listExpiredOpenRentals: async () => [],
    closeRental: async () => undefined,
    listStaleClaims: async () => [],
    markAvailable: async () => undefined,
    ...overrides,
  };
}

function reaper(store: RentalReaperStore): RentalReaper {
  return new RentalReaper({
    store,
    sessions: { stateOf: async () => null, hasActiveSessionForLicense: async () => false },
    now: () => FIXED,
  });
}

describe('RentalReaper — pair-payload cleanup obligation', () => {
  it('runs the sweep and reports how many payloads were cleared', async () => {
    const result = await reaper(reaperStore({ clearStalePairPayloads: async () => 3 })).reconcile();
    expect(result.clearedPairPayloads).toBe(3);
    expect(result.errors).toEqual([]);
  });

  it('isolates a sweep failure (retried next pass) without failing the pass', async () => {
    const result = await reaper(
      reaperStore({
        clearStalePairPayloads: async () => {
          throw new Error('db down');
        },
      }),
    ).reconcile();
    expect(result.clearedPairPayloads).toBe(0);
    expect(result.errors.some((e) => e.target === 'pair-payload-cleanup')).toBe(true);
  });

  it('skips the sweep for a store that does not implement it', async () => {
    const result = await reaper(reaperStore()).reconcile();
    expect(result.clearedPairPayloads).toBe(0);
    expect(result.errors).toEqual([]);
  });
});

describe('withRetries', () => {
  it('resolves on the first success without retrying', async () => {
    let calls = 0;
    await expect(
      withRetries(async () => {
        calls++;
        return 'ok';
      }),
    ).resolves.toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries a transient failure and then resolves', async () => {
    let calls = 0;
    const value = await withRetries(
      async () => {
        calls++;
        if (calls < 3) throw new Error('transient');
        return calls;
      },
      { attempts: 5, baseDelayMs: 1, maxDelayMs: 2 },
    );
    expect(value).toBe(3);
  });

  it('throws the last error after exhausting attempts', async () => {
    let calls = 0;
    await expect(
      withRetries(
        async () => {
          calls++;
          throw new Error(`fail-${calls}`);
        },
        { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
      ),
    ).rejects.toThrow('fail-2');
    expect(calls).toBe(2);
  });
});
