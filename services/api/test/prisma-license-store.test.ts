import { describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';

import { PrismaMarketplaceStore } from '../src/marketplace/prisma-license-store.js';
import { InMemoryMarketplaceStore, type SoftwareLicense } from '../src/marketplace/license-store.js';

const p2021 = (): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError('The table `software_licenses` does not exist', {
    code: 'P2021',
    clientVersion: '6.2.0',
  });

const p2002 = (): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.2.0',
  });

function seed(): SoftwareLicense {
  return {
    id: 'lic_seed',
    softwareName: 'Seeded',
    version: '1',
    category: 'engineering',
    description: '',
    os: 'linux',
    hourlyRateUsd: 1,
    ownerId: 'owner_1',
    ownerName: 'Owner',
    status: 'available',
    currentRenteeId: null,
    encryptedCredentials: {
      v: 2,
      algorithm: 'RSA-OAEP-SHA256',
      keyBits: 4096,
      keyFingerprint: 'hsm-rsa4096-test',
      cipherTextB64: 'x',
      encryptedAt: new Date().toISOString(),
    },
    templateId: 'tmpl_linux_dev',
    createdAt: new Date().toISOString(),
  };
}

/** A PrismaClient whose every marketplace method throws `err`. */
function rejectingDb(err: unknown): PrismaClient {
  const reject = () => Promise.reject(err);
  const db = {
    softwareLicense: { findMany: reject, findUnique: reject, create: reject, update: reject, updateMany: reject },
    licenseRental: { findUnique: reject, create: reject, update: reject, updateMany: reject },
    $transaction: reject,
  };
  return db as unknown as PrismaClient;
}

describe('PrismaMarketplaceStore — dev fallback gating', () => {
  it('propagates a missing-migration error when NO fallback is configured', async () => {
    const store = new PrismaMarketplaceStore(rejectingDb(p2021()));
    await expect(store.listAvailable()).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it('degrades to the in-memory catalog when a fallback is provided', async () => {
    const fallback = new InMemoryMarketplaceStore([seed()]);
    const store = new PrismaMarketplaceStore(rejectingDb(p2021()), fallback);
    const list = await store.listAvailable();
    expect(list.map((l) => l.id)).toEqual(['lic_seed']);
  });

  it('does not fall back on a non-connection error', async () => {
    const fallback = new InMemoryMarketplaceStore([seed()]);
    const store = new PrismaMarketplaceStore(rejectingDb(new Error('boom')), fallback);
    await expect(store.listAvailable()).rejects.toThrow('boom');
  });

  it('does not fall back on a unique-violation (P2002) even with a fallback', async () => {
    const fallback = new InMemoryMarketplaceStore([seed()]);
    const store = new PrismaMarketplaceStore(rejectingDb(p2002()), fallback);
    await expect(store.listAvailable()).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });
});

/** A PrismaClient whose `softwareLicense.updateMany` is the supplied function. */
function dbWithSoftwareLicense(
  updateMany: (args: unknown) => Promise<{ count: number }>,
): PrismaClient {
  return { softwareLicense: { updateMany } } as unknown as PrismaClient;
}

describe('PrismaMarketplaceStore — atomic claim is a conditional write (audit H2)', () => {
  it('claims with ONE updateMany guarded on `available`, treating count===1 as the win', async () => {
    const seen: unknown[] = [];
    const store = new PrismaMarketplaceStore(
      dbWithSoftwareLicense(async (args) => {
        seen.push(args);
        return { count: 1 };
      }),
    );

    expect(await store.claimAvailable('lic_1', 'rentee_1')).toBe(true);
    expect(seen).toEqual([
      {
        where: { id: 'lic_1', status: 'available' },
        data: { status: 'rented', currentRenteeId: 'rentee_1' },
      },
    ]);
  });

  it('reports a lost race as a failed claim (count===0)', async () => {
    const store = new PrismaMarketplaceStore(dbWithSoftwareLicense(async () => ({ count: 0 })));
    expect(await store.claimAvailable('lic_1', 'rentee_1')).toBe(false);
  });

  it('propagates a non-connection error instead of masking it (even with a fallback)', async () => {
    const store = new PrismaMarketplaceStore(
      dbWithSoftwareLicense(async () => {
        throw p2002();
      }),
      new InMemoryMarketplaceStore([seed()]),
    );
    await expect(store.claimAvailable('lic_seed', 'rentee_1')).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
  });

  it('degrades to the in-memory claim when the DB is unreachable with a fallback', async () => {
    const store = new PrismaMarketplaceStore(rejectingDb(p2021()), new InMemoryMarketplaceStore([seed()]));
    expect(await store.claimAvailable('lic_seed', 'rentee_1')).toBe(true);
    expect(await store.findById('lic_seed')).toMatchObject({ status: 'rented', currentRenteeId: 'rentee_1' });
  });
});

describe('PrismaMarketplaceStore — pair-payload cleanup (audit M7, part C)', () => {
  it('clears the pair payload to SQL NULL when closing a rental', async () => {
    const calls: unknown[] = [];
    const db = {
      licenseRental: {
        findUnique: async () => ({ id: 'ren_1', licenseId: 'lic_1', renteeId: 'rentee_1', endedAt: null }),
        updateMany: async (args: unknown) => {
          calls.push(args);
          return { count: 1 };
        },
      },
      softwareLicense: { updateMany: async () => ({ count: 1 }) },
      $transaction: async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]),
    } as unknown as PrismaClient;

    await new PrismaMarketplaceStore(db).closeRental('ren_1', new Date('2026-01-01T00:00:00Z'));

    const clearCall = calls.find(
      (c) => typeof c === 'object' && c !== null && 'data' in c && 'pairPayload' in ((c as { data: object }).data as object),
    ) as { data: { pairPayload: unknown } } | undefined;
    expect(clearCall?.data.pairPayload).toBe(Prisma.DbNull);
  });

  it('delegates the pair-payload sweep to the fallback on a connection error', async () => {
    const store = new PrismaMarketplaceStore(rejectingDb(p2021()), new InMemoryMarketplaceStore([seed()]));
    await expect(store.clearStalePairPayloads(new Date())).resolves.toBe(0);
  });

  it('propagates a non-connection sweep error instead of masking it', async () => {
    const db = {
      licenseRental: {
        updateMany: async () => {
          throw new Error('boom');
        },
      },
    } as unknown as PrismaClient;
    await expect(new PrismaMarketplaceStore(db, new InMemoryMarketplaceStore([seed()])).clearStalePairPayloads(new Date())).rejects.toThrow(
      'boom',
    );
  });
});
