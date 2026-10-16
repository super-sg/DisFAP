/**
 * PostgreSQL-backed persistence checks — the durable `sessions.license_id` link
 * and `hasActiveForLicense`.
 *
 * These run ONLY when `DFAP_TEST_DATABASE_URL` is set, and expect a DISPOSABLE,
 * freshly-migrated database (no important data). In-memory tests cannot prove
 * the Prisma column mapping, the FK, or the composite index — this does.
 *
 *   DFAP_TEST_DATABASE_URL=postgresql://... npx vitest run test/prisma-persistence.pg.test.ts
 *
 * Skipped (not failed) when the env var is absent, so the default suite needs
 * no database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';

import { PrismaSessionRepo, PrismaIdentityRepo, PrismaIdentityProvisioningStore } from '../src/db/prisma-repos.js';
import { PrismaMarketplaceStore } from '../src/marketplace/prisma-license-store.js';
import { provisionIdentity } from '../src/auth/identity-provisioning.js';

const url = process.env['DFAP_TEST_DATABASE_URL'];

describe.skipIf(!url)('PostgreSQL persistence — sessions.license_id (disposable DB)', () => {
  let prisma: PrismaClient;
  let repo: PrismaSessionRepo;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: url as string } } });
    repo = new PrismaSessionRepo(prisma);

    // FK targets the session row requires.
    await prisma.org.upsert({ where: { id: 'org_pg' }, update: {}, create: { id: 'org_pg', name: 'PG Test Org' } });
    await prisma.user.upsert({
      where: { id: 'usr_pg' },
      update: {},
      create: { id: 'usr_pg', email: 'pg-test@example.com' },
    });
    await prisma.workspaceTemplate.upsert({
      where: { id: 'tmpl_pg' },
      update: {},
      create: {
        id: 'tmpl_pg',
        orgId: 'org_pg',
        name: 'PG Test Template',
        os: 'linux',
        connectionProtocol: 'rdp',
        guacParams: {},
      },
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('persists license_id at creation and reads it back', async () => {
    const created = await repo.create({
      orgId: 'org_pg',
      userId: 'usr_pg',
      templateId: 'tmpl_pg',
      state: 'ready',
      licenseId: 'lic_pg',
    });
    expect(created.licenseId).toBe('lic_pg');

    const loaded = await repo.findById(created.id);
    expect(loaded?.licenseId).toBe('lic_pg');
  });

  it('hasActiveForLicense is true only while a non-terminal session is linked', async () => {
    const active = await repo.create({
      orgId: 'org_pg',
      userId: 'usr_pg',
      templateId: 'tmpl_pg',
      state: 'connected',
      licenseId: 'lic_active',
    });
    expect(await repo.hasActiveForLicense('lic_active')).toBe(true);

    await repo.update(active.id, { state: 'ended', endedAt: new Date() });
    expect(await repo.hasActiveForLicense('lic_active')).toBe(false);
  });

  it('leaves license_id NULL for a base session (never a false license match)', async () => {
    const base = await repo.create({
      orgId: 'org_pg',
      userId: 'usr_pg',
      templateId: 'tmpl_pg',
      state: 'ready',
    });
    expect(base.licenseId).toBeNull();
    expect(await repo.hasActiveForLicense('lic_active')).toBe(false);
  });

  it('maps external identities by (issuer, subject) and enforces uniqueness', async () => {
    const identities = new PrismaIdentityRepo(prisma);
    await prisma.externalIdentity.create({
      data: { issuer: 'https://idp.pg.test/', subject: 'sub-1', userId: 'usr_pg', email: 'a@example.com' },
    });

    expect(await identities.resolve('https://idp.pg.test/', 'sub-1')).toBe('usr_pg');
    expect(await identities.resolve('https://idp.pg.test/', 'unknown')).toBeNull();
    // Same subject under a different issuer is a different identity.
    expect(await identities.resolve('https://other.pg.test/', 'sub-1')).toBeNull();

    await prisma.user.upsert({
      where: { id: 'usr_pg2' },
      update: {},
      create: { id: 'usr_pg2', email: 'pg2@example.com' },
    });
    // The (issuer, subject) unique constraint blocks a second mapping.
    await expect(
      prisma.externalIdentity.create({
        data: { issuer: 'https://idp.pg.test/', subject: 'sub-1', userId: 'usr_pg2' },
      }),
    ).rejects.toThrow();
  });

  it('provisions external identities idempotently and blocks silent reassignment', async () => {
    await prisma.user.upsert({
      where: { id: 'usr_pg2' },
      update: {},
      create: { id: 'usr_pg2', email: 'pg2@example.com' },
    });
    const store = new PrismaIdentityProvisioningStore(prisma);
    const mapping = { issuer: 'https://idp.pg.test/', subject: 'prov-sub-1', userId: 'usr_pg' };

    expect(await provisionIdentity(store, mapping)).toBe('created');
    expect(await provisionIdentity(store, mapping)).toBe('unchanged');
    // Refuses to repoint an existing mapping without the explicit opt-in.
    await expect(provisionIdentity(store, { ...mapping, userId: 'usr_pg2' })).rejects.toThrow(/refusing to reassign/);
    expect(await provisionIdentity(store, { ...mapping, userId: 'usr_pg2', reassign: true })).toBe('reassigned');
    expect(await new PrismaIdentityRepo(prisma).resolve('https://idp.pg.test/', 'prov-sub-1')).toBe('usr_pg2');
    // A nonexistent user is rejected.
    await expect(provisionIdentity(store, { ...mapping, subject: 'prov-sub-2', userId: 'usr_ghost' })).rejects.toThrow(
      /no such DisFAP user/,
    );
  });

  it('stores the rental pair payload as JSON and clears it to SQL NULL on close', async () => {
    const store = new PrismaMarketplaceStore(prisma);
    const pair = { v: 1, alg: 'AES-256-GCM-HKDF', iv: 'a', tag: 'b', ct: 'c', pair: 'd' };

    await prisma.softwareLicense.create({
      data: {
        id: 'lic_pair_pg',
        ownerId: 'usr_pg',
        ownerName: 'Owner',
        softwareName: 'PG Software',
        version: '1',
        category: 'engineering',
        os: 'linux',
        hourlyRateUsd: new Prisma.Decimal(1),
        encryptedCredentials: {
          v: 2,
          algorithm: 'RSA-OAEP-SHA256',
          keyBits: 4096,
          keyFingerprint: 'kid',
          cipherTextB64: 'x',
          encryptedAt: new Date().toISOString(),
        },
        keyFingerprint: 'kid',
        templateId: 'tmpl_pg',
      },
    });
    await prisma.licenseRental.create({
      data: {
        id: 'ren_pair_pg',
        licenseId: 'lic_pair_pg',
        renteeId: 'usr_pg',
        sessionId: 'ses_pair_pg',
        hoursRequested: 1,
        totalChargedUsd: new Prisma.Decimal(1),
        pairPayload: pair,
      },
    });
    expect((await prisma.licenseRental.findUnique({ where: { id: 'ren_pair_pg' } }))?.pairPayload).toEqual(pair);

    await store.closeRental('ren_pair_pg', new Date());
    const after = await prisma.licenseRental.findUnique({ where: { id: 'ren_pair_pg' } });
    expect(after?.pairPayload).toBeNull();
    expect(after?.endedAt).not.toBeNull();

    // Idempotent: the sweep has nothing left to clear for this row.
    expect(await store.clearStalePairPayloads(new Date())).toBe(0);
    expect((await prisma.licenseRental.findUnique({ where: { id: 'ren_pair_pg' } }))?.pairPayload).toBeNull();
  });

  it('sweeps a stale pair payload on an already-ended rental (idempotent)', async () => {
    const store = new PrismaMarketplaceStore(prisma);
    const pair = { v: 1, alg: 'AES-256-GCM-HKDF', iv: 'a', tag: 'b', ct: 'c', pair: 'e' };
    await prisma.licenseRental.create({
      data: {
        id: 'ren_stale_pg',
        licenseId: 'lic_pair_pg',
        renteeId: 'usr_pg',
        sessionId: 'ses_stale_pg',
        hoursRequested: 1,
        totalChargedUsd: new Prisma.Decimal(1),
        pairPayload: pair,
        endedAt: new Date(),
      },
    });

    expect(await store.clearStalePairPayloads(new Date())).toBeGreaterThanOrEqual(1);
    expect((await prisma.licenseRental.findUnique({ where: { id: 'ren_stale_pg' } }))?.pairPayload).toBeNull();
    // Second pass clears nothing.
    expect(await store.clearStalePairPayloads(new Date())).toBe(0);
  });
});
