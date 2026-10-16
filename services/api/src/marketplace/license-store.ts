/**
 * Layer 1: Owner and Rentee Software License Marketplace (DisFAP Spec Layer 1).
 *
 * Defines models and stores for:
 *  - Software owners listing their licenses (with credentials encrypted via Layer 2 HSM RSA-4096).
 *  - Rentees browsing software catalog, hourly rates, OS requirements.
 *  - Rental transactions that trigger the Layer 3 Orchestrator.
 */

import type { EncryptedCredentialPayload } from '../crypto/hsm-rsa.js';
import type { PairEncryptedPayload } from '../crypto/pair-keys.js';

// Re-exported so marketplace consumers need only this module.
export type { PairEncryptedPayload };

export type SoftwareCategory = 'engineering' | 'design' | 'development' | 'data-science' | 'productivity';

export interface SoftwareLicense {
  id: string;
  softwareName: string;
  version: string;
  category: SoftwareCategory;
  description: string;
  os: 'windows' | 'linux';
  hourlyRateUsd: number;
  ownerId: string;
  ownerName: string;
  status: 'available' | 'rented' | 'paused';
  currentRenteeId: string | null;
  /** Encrypted using Layer 2 HSM RSA-4096; plaintext is never stored */
  encryptedCredentials: EncryptedCredentialPayload;
  /** Associated base VM template configured for this software */
  templateId: string;
  createdAt: string;
}

/** One owner-rentee rental, keyed to the pixel session it drove (spec layer 3). */
export interface RentalRecord {
  id: string;
  licenseId: string;
  renteeId: string;
  /** The pixel session this rental created; unique while the rental is open. */
  sessionId: string;
  hoursRequested: number;
  totalChargedUsd: number;
  /** Stripe meter event reporting this rental (idempotent). */
  meterEventId: string | null;
  /** Credential re-sealed under the per owner-rentee pair key (spec TA-4). */
  pairPayload?: PairEncryptedPayload;
  startedAt: string;
  endedAt: string | null;
}

export interface RecordRentalInput {
  licenseId: string;
  renteeId: string;
  sessionId: string;
  hoursRequested: number;
  totalChargedUsd: number;
  meterEventId?: string;
  pairPayload?: PairEncryptedPayload;
}

export interface CreateLicenseInput {
  softwareName: string;
  version: string;
  category: SoftwareCategory;
  description: string;
  os: 'windows' | 'linux';
  hourlyRateUsd: number;
  ownerName?: string;
  encryptedCredentials: EncryptedCredentialPayload;
  templateId?: string;
}

/** An open rental reduced to the fields the rental reaper needs. */
export interface RentalLease {
  rentalId: string;
  licenseId: string;
  sessionId: string;
  /** `startedAt + hoursRequested` — when the paid-for window ends. */
  leaseExpiresAt: Date;
}

export interface MarketplaceStore {
  listAvailable(category?: string): Promise<SoftwareLicense[]>;
  findById(id: string): Promise<SoftwareLicense | null>;
  create(ownerId: string, input: CreateLicenseInput): Promise<SoftwareLicense>;

  /**
   * Atomically claim `id` for `renteeId` IFF it is currently `available`.
   * Returns true only for the single caller that won; false when it was
   * already taken or does not exist. Implementations MUST use a conditional
   * write (compare-and-set), never read-then-write — this is the concurrency
   * guard that makes a double-rent impossible (audit finding H2).
   */
  claimAvailable(id: string, renteeId: string): Promise<boolean>;

  /**
   * Release a claim IFF it is still held by `renteeId` (conditional, atomic).
   * Returns true when this caller released it. Used by the orchestrator to
   * compensate a failed rent WITHOUT ever touching another tenant's claim.
   */
  releaseClaim(id: string, renteeId: string): Promise<boolean>;

  /** Unconditional force-set: admin/owner offboarding or the dev re-rent path. */
  markRented(id: string, renteeId: string): Promise<void>;
  markAvailable(id: string): Promise<void>;

  /**
   * True iff `licenseId` is currently rented to `renteeId` AND its template is
   * `templateId`. This is the data-backed authorization that lets a marketplace
   * session legally launch a template owned by another org (audit finding C2).
   */
  isLicensedTo(licenseId: string, renteeId: string, templateId: string): Promise<boolean>;

  /** Persist one rental (called by the layer-3 orchestrator at rent time). */
  recordRental(input: RecordRentalInput): Promise<RentalRecord>;
  /** Attach the Stripe meter event id to an already-recorded rental (idempotent). */
  attachMeterEvent(rentalId: string, meterEventId: string): Promise<void>;
  /** Close the rental tied to a pixel session and release its license. */
  completeForSession(sessionId: string): Promise<void>;
  /** Close one rental by id and release its license (rental reaper path). */
  closeRental(rentalId: string, at: Date): Promise<void>;
  /** The open (or most recent) rental for a pixel session, if any. */
  findRentalBySession(sessionId: string): Promise<RentalRecord | null>;

  /**
   * Idempotent cleanup obligation: clear the rental-scoped pair payload for
   * every rental that has already ended (at or before `olderThan`). The
   * payload exists only for the duration of a rental; this is a durable
   * backstop for a rental that ended without its payload being cleared inline.
   * Returns the number of rows whose payload was cleared.
   */
  clearStalePairPayloads(olderThan: Date): Promise<number>;

  /** Open rentals whose paid-for window has ended by `now` (reaper input). */
  listExpiredOpenRentals(now: Date): Promise<RentalLease[]>;
  /**
   * Rented licenses with NO open rental that have not changed since before
   * `olderThan` — i.e. claims orphaned by a crash between claim and rental
   * persistence. Returns license ids (reaper input).
   */
  listStaleClaims(olderThan: Date): Promise<string[]>;
}

export class InMemoryMarketplaceStore implements MarketplaceStore {
  private readonly licenses = new Map<string, SoftwareLicense>();
  private readonly rentals = new Map<string, RentalRecord>();
  private readonly rentalBySession = new Map<string, string>();
  /** Claim/release timestamps for stale-claim detection (mirrors updated_at). */
  private readonly updatedAtMs = new Map<string, number>();
  private idSequence = 1;
  private rentalIdSequence = 1;

  constructor(initialLicenses?: SoftwareLicense[]) {
    if (initialLicenses) {
      for (const lic of initialLicenses) {
        this.licenses.set(lic.id, lic);
        this.updatedAtMs.set(lic.id, Date.now());
      }
    }
  }

  async listAvailable(category?: string): Promise<SoftwareLicense[]> {
    return Array.from(this.licenses.values()).filter((lic) => {
      const isAvailable = lic.status === 'available';
      if (!isAvailable) return false;
      return category ? lic.category === category : true;
    });
  }

  async findById(id: string): Promise<SoftwareLicense | null> {
    return this.licenses.get(id) ?? null;
  }

  async create(ownerId: string, input: CreateLicenseInput): Promise<SoftwareLicense> {
    const id = `lic_${this.idSequence++}`;
    const license: SoftwareLicense = {
      id,
      softwareName: input.softwareName,
      version: input.version,
      category: input.category,
      description: input.description,
      os: input.os,
      hourlyRateUsd: input.hourlyRateUsd,
      ownerId,
      ownerName: input.ownerName ?? 'Verified Owner',
      status: 'available',
      currentRenteeId: null,
      encryptedCredentials: input.encryptedCredentials,
      templateId: input.templateId ?? (input.os === 'windows' ? 'tmpl_win_rdp' : 'tmpl_linux_dev'),
      createdAt: new Date().toISOString(),
    };

    this.licenses.set(id, license);
    this.updatedAtMs.set(id, Date.now());
    return license;
  }

  /**
   * Atomic compare-and-set: succeeds for exactly one caller while the license
   * is `available`. The in-memory map makes this single-threaded-atomic; the
   * Prisma store does the equivalent with a conditional `updateMany`.
   */
  async claimAvailable(id: string, renteeId: string): Promise<boolean> {
    const lic = this.licenses.get(id);
    if (!lic || lic.status !== 'available') return false;
    lic.status = 'rented';
    lic.currentRenteeId = renteeId;
    this.updatedAtMs.set(id, Date.now());
    return true;
  }

  /** Conditional release: only the holder can give the claim back. */
  async releaseClaim(id: string, renteeId: string): Promise<boolean> {
    const lic = this.licenses.get(id);
    if (!lic || lic.status !== 'rented' || lic.currentRenteeId !== renteeId) return false;
    lic.status = 'available';
    lic.currentRenteeId = null;
    this.updatedAtMs.set(id, Date.now());
    return true;
  }

  async isLicensedTo(licenseId: string, renteeId: string, templateId: string): Promise<boolean> {
    const lic = this.licenses.get(licenseId);
    return (
      !!lic &&
      lic.status === 'rented' &&
      lic.currentRenteeId === renteeId &&
      lic.templateId === templateId
    );
  }

  async markRented(id: string, renteeId: string): Promise<void> {
    const lic = this.licenses.get(id);
    if (!lic) throw new Error(`License ${id} not found`);
    lic.status = 'rented';
    lic.currentRenteeId = renteeId;
    this.updatedAtMs.set(id, Date.now());
  }

  async markAvailable(id: string): Promise<void> {
    const lic = this.licenses.get(id);
    if (!lic) return;
    lic.status = 'available';
    lic.currentRenteeId = null;
    this.updatedAtMs.set(id, Date.now());
  }

  async recordRental(input: RecordRentalInput): Promise<RentalRecord> {
    const rental: RentalRecord = {
      id: `ren_${this.rentalIdSequence++}`,
      licenseId: input.licenseId,
      renteeId: input.renteeId,
      sessionId: input.sessionId,
      hoursRequested: input.hoursRequested,
      totalChargedUsd: input.totalChargedUsd,
      ...(input.meterEventId !== undefined ? { meterEventId: input.meterEventId } : { meterEventId: null }),
      ...(input.pairPayload !== undefined ? { pairPayload: input.pairPayload } : {}),
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.rentals.set(rental.id, rental);
    this.rentalBySession.set(rental.sessionId, rental.id);
    return rental;
  }

  async completeForSession(sessionId: string): Promise<void> {
    const rentalId = this.rentalBySession.get(sessionId);
    if (!rentalId) return; // a base-workspace session has no rental to close
    await this.closeRental(rentalId, new Date());
  }

  async attachMeterEvent(rentalId: string, meterEventId: string): Promise<void> {
    const rental = this.rentals.get(rentalId);
    if (rental && rental.meterEventId === null) rental.meterEventId = meterEventId;
  }

  async closeRental(rentalId: string, at: Date): Promise<void> {
    const rental = this.rentals.get(rentalId);
    if (!rental) return;
    if (!rental.endedAt) rental.endedAt = at.toISOString();
    // The pair payload is rental-scoped: once the rental is over it is no
    // longer needed and is dropped (idempotent — clearing twice is a no-op).
    delete rental.pairPayload;
    await this.markAvailable(rental.licenseId);
  }

  async clearStalePairPayloads(olderThan: Date): Promise<number> {
    let cleared = 0;
    for (const rental of this.rentals.values()) {
      if (!rental.endedAt || !rental.pairPayload) continue;
      if (new Date(rental.endedAt).getTime() > olderThan.getTime()) continue;
      delete rental.pairPayload;
      cleared++;
    }
    return cleared;
  }

  async findRentalBySession(sessionId: string): Promise<RentalRecord | null> {
    const rentalId = this.rentalBySession.get(sessionId);
    return rentalId ? (this.rentals.get(rentalId) ?? null) : null;
  }

  async listExpiredOpenRentals(now: Date): Promise<RentalLease[]> {
    const nowMs = now.getTime();
    const out: RentalLease[] = [];
    for (const rental of this.rentals.values()) {
      if (rental.endedAt) continue;
      const leaseExpiresAt = new Date(new Date(rental.startedAt).getTime() + rental.hoursRequested * 3_600_000);
      if (leaseExpiresAt.getTime() <= nowMs) {
        out.push({ rentalId: rental.id, licenseId: rental.licenseId, sessionId: rental.sessionId, leaseExpiresAt });
      }
    }
    return out;
  }

  async listStaleClaims(olderThan: Date): Promise<string[]> {
    const openLicenseIds = new Set<string>();
    for (const rental of this.rentals.values()) {
      if (!rental.endedAt) openLicenseIds.add(rental.licenseId);
    }
    const out: string[] = [];
    for (const lic of this.licenses.values()) {
      if (lic.status !== 'rented') continue;
      if (openLicenseIds.has(lic.id)) continue; // a real rental exists — not stale
      const updated = this.updatedAtMs.get(lic.id);
      if (updated !== undefined && updated < olderThan.getTime()) out.push(lic.id);
    }
    return out;
  }
}
