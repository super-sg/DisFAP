/**
 * Prisma-backed marketplace store — persistence for the layer-1 software
 * catalog and the layer-3 rental ledger (`software_licenses` /
 * `license_rentals` in schema.prisma).
 *
 * Every method falls back to a caller-supplied dev store when the database is
 * unreachable, matching the control plane's Phase-0 philosophy (see
 * `server.ts` `safeCreateSession`): dev without Postgres keeps working, while
 * production fail-fast behaviour is preserved for real tenants because the
 * rethrow-on-no-fallback path stays a hard error.
 */

import {
  Prisma,
  type PrismaClient,
  LicenseStatus as DbLicenseStatus,
  Os as DbOs,
} from '@prisma/client';

import type {
  CreateLicenseInput,
  MarketplaceStore,
  RecordRentalInput,
  RentalLease,
  RentalRecord,
  SoftwareLicense,
  SoftwareCategory,
} from './license-store.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LicenseRow = any;

function categoryOf(row: LicenseRow): SoftwareCategory {
  return row.category as SoftwareCategory;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toLicense(row: LicenseRow): SoftwareLicense {
  return {
    id: row.id,
    softwareName: row.softwareName,
    version: row.version,
    category: categoryOf(row),
    description: row.description ?? '',
    os: row.os === 'windows' ? 'windows' : 'linux',
    hourlyRateUsd: Number(row.hourlyRateUsd),
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    status: row.status,
    currentRenteeId: row.currentRenteeId ?? null,
    encryptedCredentials: row.encryptedCredentials,
    templateId: row.templateId,
    createdAt: row.createdAt.toISOString(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRental(row: LicenseRow): RentalRecord {
  return {
    id: row.id,
    licenseId: row.licenseId,
    renteeId: row.renteeId,
    sessionId: row.sessionId,
    hoursRequested: row.hoursRequested,
    totalChargedUsd: Number(row.totalChargedUsd),
    meterEventId: row.meterEventId ?? null,
    ...(row.pairPayload ? { pairPayload: row.pairPayload } : {}),
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
  };
}

export class PrismaMarketplaceStore implements MarketplaceStore {
  constructor(
    private readonly db: PrismaClient,
    /** Used only when the database is unreachable (dev). */
    private readonly fallback?: MarketplaceStore,
  ) {}

  private isConnErr(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientInitializationError ||
      err instanceof Prisma.PrismaClientRustPanicError ||
      // Dev degradation: the local DB exists but migrations haven't been
      // applied yet (table/column missing). Any OTHER Prisma error — e.g. a
      // unique-violation on a double-rent — must propagate, never silently
      // fall back to the in-memory store.
      (err instanceof Prisma.PrismaClientKnownRequestError && ['P2021', 'P2022'].includes(err.code))
    );
  }

  async listAvailable(category?: string): Promise<SoftwareLicense[]> {
    try {
      const rows = await this.db.softwareLicense.findMany({
        where: { status: DbLicenseStatus.available, ...(category ? { category } : {}) },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(toLicense);
    } catch (err) {
      if (this.fallback && this.isConnErr(err)) return this.fallback.listAvailable(category);
      throw err;
    }
  }

  async findById(id: string): Promise<SoftwareLicense | null> {
    try {
      const row = await this.db.softwareLicense.findUnique({ where: { id } });
      return row ? toLicense(row) : null;
    } catch (err) {
      if (this.fallback && this.isConnErr(err)) return this.fallback.findById(id);
      throw err;
    }
  }

  async create(ownerId: string, input: CreateLicenseInput): Promise<SoftwareLicense> {
    try {
      const row = await this.db.softwareLicense.create({
        data: {
          ownerId,
          ownerName: input.ownerName ?? 'Verified Owner',
          softwareName: input.softwareName,
          version: input.version,
          category: input.category,
          description: input.description,
          os: (input.os === 'windows' ? 'windows' : 'linux') as DbOs,
          hourlyRateUsd: new Prisma.Decimal(input.hourlyRateUsd),
          status: DbLicenseStatus.available,
          encryptedCredentials: input.encryptedCredentials as unknown as Prisma.InputJsonValue,
          keyFingerprint: input.encryptedCredentials.keyFingerprint,
          templateId: input.templateId ?? (input.os === 'windows' ? 'tmpl_win_rdp' : 'tmpl_linux_dev'),
        },
      });
      return toLicense(row);
    } catch (err) {
      if (this.fallback && this.isConnErr(err)) return this.fallback.create(ownerId, input);
      throw err;
    }
  }

  async markRented(id: string, renteeId: string): Promise<void> {
    try {
      await this.db.softwareLicense.update({ where: { id }, data: { status: DbLicenseStatus.rented, currentRenteeId: renteeId } });
    } catch (err) {
      if (this.fallback && this.isConnErr(err)) return this.fallback.markRented(id, renteeId);
      throw err;
    }
  }

  /**
   * Atomic compare-and-set. A single conditional `updateMany` guarded on the
   * current status is the concurrency primitive: Postgres serializes the row
   * update, so exactly one concurrent caller sees `count === 1` and the rest
   * see `0` (audit finding H2 — no check-then-act).
   */
  async claimAvailable(id: string, renteeId: string): Promise<boolean> {
    try {
      const res = await this.db.softwareLicense.updateMany({
        where: { id, status: DbLicenseStatus.available },
        data: { status: DbLicenseStatus.rented, currentRenteeId: renteeId },
      });
      return res.count === 1;
    } catch (err) {
      if (this.fallback && this.isConnErr(err)) return this.fallback.claimAvailable(id, renteeId);
      throw err;
    }
  }

  /** Conditional release: only the current holder can hand the claim back. */
  async releaseClaim(id: string, renteeId: string): Promise<boolean> {
    try {
      const res = await this.db.softwareLicense.updateMany({
        where: { id, status: DbLicenseStatus.rented, currentRenteeId: renteeId },
        data: { status: DbLicenseStatus.available, currentRenteeId: null },
      });
      return res.count === 1;
    } catch (err) {
      if (this.fallback && this.isConnErr(err)) return this.fallback.releaseClaim(id, renteeId);
      throw err;
    }
  }

  async isLicensedTo(licenseId: string, renteeId: string, templateId: string): Promise<boolean> {
    try {
      const row = await this.db.softwareLicense.findFirst({
        where: { id: licenseId, templateId, status: DbLicenseStatus.rented, currentRenteeId: renteeId },
        select: { id: true },
      });
      return row !== null;
    } catch (err) {
      if (this.fallback && this.isConnErr(err)) return this.fallback.isLicensedTo(licenseId, renteeId, templateId);
      throw err;
    }
  }

  async attachMeterEvent(rentalId: string, meterEventId: string): Promise<void> {
    try {
      await this.db.licenseRental.updateMany({
        where: { id: rentalId, meterEventId: null },
        data: { meterEventId },
      });
    } catch (err) {
      if (this.fallback && this.isConnErr(err)) return this.fallback.attachMeterEvent(rentalId, meterEventId);
      throw err;
    }
  }

  async markAvailable(id: string): Promise<void> {
    try {
      await this.db.softwareLicense.updateMany({
        where: { id },
        data: { status: DbLicenseStatus.available, currentRenteeId: null },
      });
    } catch (err) {
      if (this.fallback && this.isConnErr(err)) return this.fallback.markAvailable(id);
      throw err;
    }
  }

  async recordRental(input: RecordRentalInput): Promise<RentalRecord> {
    try {
      const row = await this.db.licenseRental.create({
        data: {
          licenseId: input.licenseId,
          renteeId: input.renteeId,
          sessionId: input.sessionId,
          hoursRequested: input.hoursRequested,
          totalChargedUsd: new Prisma.Decimal(input.totalChargedUsd),
          ...(input.meterEventId !== undefined ? { meterEventId: input.meterEventId } : {}),
          ...(input.pairPayload !== undefined ? { pairPayload: input.pairPayload as unknown as Prisma.InputJsonValue } : {}),
        },
      });
      return toRental(row);
    } catch (err) {
      if (this.fallback && this.isConnErr(err)) return this.fallback.recordRental(input);
      throw err;
    }
  }

  async completeForSession(sessionId: string): Promise<void> {
    try {
      const rental = await this.db.licenseRental.findUnique({ where: { sessionId } });
      if (!rental) return;
      await this.db.$transaction([
        this.db.licenseRental.update({
          where: { sessionId },
          // Clearing the rental-scoped pair payload is part of closing.
          data: { endedAt: rental.endedAt ?? new Date(), pairPayload: Prisma.DbNull },
        }),
        this.db.softwareLicense.update({
          where: { id: rental.licenseId },
          data: { status: DbLicenseStatus.available, currentRenteeId: null },
        }),
      ]);
    } catch (err) {
      if (this.fallback && this.isConnErr(err)) return this.fallback.completeForSession(sessionId);
      throw err;
    }
  }

  async findRentalBySession(sessionId: string): Promise<RentalRecord | null> {
    try {
      const row = await this.db.licenseRental.findUnique({ where: { sessionId } });
      return row ? toRental(row) : null;
    } catch (err) {
      if (this.fallback && this.isConnErr(err)) return this.fallback.findRentalBySession(sessionId);
      throw err;
    }
  }

  async closeRental(rentalId: string, at: Date): Promise<void> {
    try {
      const rental = await this.db.licenseRental.findUnique({ where: { id: rentalId } });
      if (!rental) return;
      await this.db.$transaction([
        // Idempotent: only stamps ended_at when still open.
        this.db.licenseRental.updateMany({ where: { id: rentalId, endedAt: null }, data: { endedAt: at } }),
        // Clear the rental-scoped pair payload (idempotent).
        this.db.licenseRental.updateMany({ where: { id: rentalId }, data: { pairPayload: Prisma.DbNull } }),
        // Conditional release: only frees the license still held by this rental.
        this.db.softwareLicense.updateMany({
          where: { id: rental.licenseId, status: DbLicenseStatus.rented, currentRenteeId: rental.renteeId },
          data: { status: DbLicenseStatus.available, currentRenteeId: null },
        }),
      ]);
    } catch (err) {
      if (this.fallback && this.isConnErr(err)) return this.fallback.closeRental(rentalId, at);
      throw err;
    }
  }

  async clearStalePairPayloads(olderThan: Date): Promise<number> {
    try {
      const res = await this.db.licenseRental.updateMany({
        where: { endedAt: { not: null, lte: olderThan }, pairPayload: { not: Prisma.DbNull } },
        data: { pairPayload: Prisma.DbNull },
      });
      return res.count;
    } catch (err) {
      if (this.fallback && this.isConnErr(err)) return this.fallback.clearStalePairPayloads(olderThan);
      throw err;
    }
  }

  async listExpiredOpenRentals(now: Date): Promise<RentalLease[]> {
    try {
      const rows = await this.db.licenseRental.findMany({
        where: { endedAt: null },
        select: { id: true, licenseId: true, sessionId: true, startedAt: true, hoursRequested: true },
      });
      const nowMs = now.getTime();
      return rows
        .map((r) => ({
          rentalId: r.id,
          licenseId: r.licenseId,
          sessionId: r.sessionId,
          leaseExpiresAt: new Date(r.startedAt.getTime() + r.hoursRequested * 3_600_000),
        }))
        .filter((r) => r.leaseExpiresAt.getTime() <= nowMs);
    } catch (err) {
      if (this.fallback && this.isConnErr(err)) return this.fallback.listExpiredOpenRentals(now);
      throw err;
    }
  }

  async listStaleClaims(olderThan: Date): Promise<string[]> {
    try {
      const rows = await this.db.softwareLicense.findMany({
        where: {
          status: DbLicenseStatus.rented,
          updatedAt: { lt: olderThan },
          rentals: { none: { endedAt: null } },
        },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    } catch (err) {
      if (this.fallback && this.isConnErr(err)) return this.fallback.listStaleClaims(olderThan);
      throw err;
    }
  }
}
