import { describe, expect, it } from 'vitest';

import { InMemoryMarketplaceStore } from '../src/marketplace/license-store.js';
import type { EncryptedCredentialPayload } from '../src/crypto/hsm-rsa.js';

const CREDS: EncryptedCredentialPayload = {
  v: 2,
  algorithm: 'RSA-OAEP-SHA256',
  keyBits: 4096,
  keyFingerprint: 'hsm-rsa4096-test',
  cipherTextB64: 'x',
  encryptedAt: new Date().toISOString(),
};

async function storeWithLicense(templateId = 'tmpl_win_rdp'): Promise<{
  store: InMemoryMarketplaceStore;
  id: string;
}> {
  const store = new InMemoryMarketplaceStore();
  const lic = await store.create('owner_1', {
    softwareName: 'MATLAB & Simulink R2024b',
    version: 'R2024b',
    category: 'engineering',
    description: 'Numerical computing',
    os: 'windows',
    hourlyRateUsd: 4.5,
    templateId,
    encryptedCredentials: CREDS,
  });
  return { store, id: lic.id };
}

describe('InMemoryMarketplaceStore — atomic claim (audit H2)', () => {
  it('lets EXACTLY ONE of many concurrent claimants win', async () => {
    const { store, id } = await storeWithLicense();

    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) => store.claimAvailable(id, `rentee_${i}`)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    const lic = await store.findById(id);
    expect(lic?.status).toBe('rented');
    // The winner is the single caller that saw true.
    expect(results.indexOf(true)).toBeGreaterThanOrEqual(0);
  });

  it('fails the claim when the license is not available', async () => {
    const { store, id } = await storeWithLicense();
    await store.markRented(id, 'someone_else');
    expect(await store.claimAvailable(id, 'rentee_1')).toBe(false);
    expect((await store.findById(id))?.currentRenteeId).toBe('someone_else');
  });

  it('fails the claim for an unknown license', async () => {
    const store = new InMemoryMarketplaceStore();
    expect(await store.claimAvailable('lic_missing', 'rentee_1')).toBe(false);
  });

  it('releaseClaim frees only the CURRENT holder', async () => {
    const { store, id } = await storeWithLicense();
    await store.claimAvailable(id, 'rentee_a');

    expect(await store.releaseClaim(id, 'rentee_b')).toBe(false);
    expect((await store.findById(id))?.status).toBe('rented');

    expect(await store.releaseClaim(id, 'rentee_a')).toBe(true);
    const lic = await store.findById(id);
    expect(lic?.status).toBe('available');
    expect(lic?.currentRenteeId).toBeNull();
  });
});

describe('InMemoryMarketplaceStore — marketplace authorization (audit C2)', () => {
  it('isLicensedTo requires rented + matching rentee + matching template', async () => {
    const { store, id } = await storeWithLicense('tpl_owner_win');

    // Not rented yet → not licensed to anyone.
    expect(await store.isLicensedTo(id, 'rentee_1', 'tpl_owner_win')).toBe(false);

    await store.claimAvailable(id, 'rentee_1');
    expect(await store.isLicensedTo(id, 'rentee_1', 'tpl_owner_win')).toBe(true);
    // Wrong rentee.
    expect(await store.isLicensedTo(id, 'rentee_2', 'tpl_owner_win')).toBe(false);
    // Wrong template — the grant must name the license's OWN template.
    expect(await store.isLicensedTo(id, 'rentee_1', 'tpl_someone_else')).toBe(false);
  });
});

describe('InMemoryMarketplaceStore — meter + rental lifecycle', () => {
  it('attachMeterEvent fills a null id once and never overwrites it', async () => {
    const { store, id } = await storeWithLicense();
    await store.claimAvailable(id, 'rentee_1');
    const rental = await store.recordRental({
      licenseId: id,
      renteeId: 'rentee_1',
      sessionId: 'ses_1',
      hoursRequested: 1,
      totalChargedUsd: 4.5,
    });
    expect(rental.meterEventId).toBeNull();

    await store.attachMeterEvent(rental.id, 'mev_1');
    expect((await store.findRentalBySession('ses_1'))?.meterEventId).toBe('mev_1');

    // Idempotent: a retry with a different id does not clobber the real one.
    await store.attachMeterEvent(rental.id, 'mev_2');
    expect((await store.findRentalBySession('ses_1'))?.meterEventId).toBe('mev_1');
  });

  it('closeRental stamps ended_at once and releases the license (idempotent)', async () => {
    const { store, id } = await storeWithLicense();
    await store.claimAvailable(id, 'rentee_1');
    const rental = await store.recordRental({
      licenseId: id,
      renteeId: 'rentee_1',
      sessionId: 'ses_1',
      hoursRequested: 1,
      totalChargedUsd: 4.5,
    });

    const at = new Date('2026-07-22T13:00:00Z');
    await store.closeRental(rental.id, at);
    await store.closeRental(rental.id, new Date('2026-07-22T14:00:00Z')); // second call: no-op

    const closed = await store.findRentalBySession('ses_1');
    expect(closed?.endedAt).toBe(at.toISOString());
    expect((await store.findById(id))?.status).toBe('available');
  });

  it('listExpiredOpenRentals returns only rentals past their paid window', async () => {
    const { store, id } = await storeWithLicense();
    await store.claimAvailable(id, 'rentee_1');
    await store.recordRental({
      licenseId: id,
      renteeId: 'rentee_1',
      sessionId: 'ses_1',
      hoursRequested: 1,
      totalChargedUsd: 4.5,
    });

    expect(await store.listExpiredOpenRentals(new Date())).toHaveLength(0);
    const later = new Date(Date.now() + 2 * 3_600_000);
    const expired = await store.listExpiredOpenRentals(later);
    expect(expired).toHaveLength(1);
    expect(expired[0]!.sessionId).toBe('ses_1');
  });

  it('listStaleClaims finds a rented license that has no open rental', async () => {
    const { store, id } = await storeWithLicense();
    await store.claimAvailable(id, 'rentee_1'); // claimed but no rental row (crash window)

    // Not stale yet within the grace window…
    expect(await store.listStaleClaims(new Date(Date.now() - 60_000))).toEqual([]);
    // …but stale once we look from beyond the claim time.
    expect(await store.listStaleClaims(new Date(Date.now() + 3_600_000))).toEqual([id]);
  });

  it('a rented license WITH an open rental is never reported stale', async () => {
    const { store, id } = await storeWithLicense();
    await store.claimAvailable(id, 'rentee_1');
    await store.recordRental({
      licenseId: id,
      renteeId: 'rentee_1',
      sessionId: 'ses_1',
      hoursRequested: 1,
      totalChargedUsd: 4.5,
    });
    expect(await store.listStaleClaims(new Date(Date.now() + 3_600_000))).toEqual([]);
  });
});
