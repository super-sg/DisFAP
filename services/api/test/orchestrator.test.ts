import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { SoftwareHsm } from '../src/crypto/hsm-rsa.js';
import { PairKeyService } from '../src/crypto/pair-keys.js';
import { InMemoryMarketplaceStore } from '../src/marketplace/license-store.js';
import { TwoThreadOrchestrator, type TwoThreadOrchestratorDeps } from '../src/orchestrator/two-thread-orchestrator.js';
import type { Principal } from '../src/auth/authenticator.js';
import type { CreateSessionInput, CreateSessionResult } from '../src/sessions/create-session.js';

const MASTER = Buffer.alloc(32, 7);
const OWNER = 'owner_matlab_edu';
const RENTEE = 'rentee_student_42';
const PRINCIPAL: Principal = { userId: RENTEE, orgId: 'org_1', role: 'member' };
const LICENSE_CREDS = { username: 'matlab_user', password: 'DisFAP_Session_Password_2026!' };

/** Fast (2048-bit) HSM keypair — the algorithm label is what matters to the HSM seam. */
function fastHsm(): SoftwareHsm {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return new SoftwareHsm({ publicKeyPem: publicKey, privateKeyPem: privateKey, keyId: 'hsm-test', minModulusBits: 2048 });
}

interface Harness {
  orchestrator: TwoThreadOrchestrator;
  store: InMemoryMarketplaceStore;
  pairKeys: PairKeyService;
  createSession: ReturnType<typeof vi.fn>;
  reportMeterEvent: ReturnType<typeof vi.fn>;
  terminateSession: ReturnType<typeof vi.fn>;
  licenseId: string;
}

async function harness(
  hsm: SoftwareHsm,
  opts: { devAllowRerent?: boolean; terminateSession?: (sessionId: string) => Promise<{ state: string }> } = {},
): Promise<Harness> {
  const store = new InMemoryMarketplaceStore();
  const license = await store.create(OWNER, {
    softwareName: 'MATLAB & Simulink R2024b',
    version: 'R2024b',
    category: 'engineering',
    description: 'Numerical computing',
    os: 'windows',
    hourlyRateUsd: 4.5,
    ownerName: 'Academic License Pool',
    templateId: 'tmpl_win_rdp',
    encryptedCredentials: hsm.encrypt(JSON.stringify(LICENSE_CREDS)),
  });

  const createSession = vi.fn(
    async (_p: Principal, input: CreateSessionInput): Promise<CreateSessionResult> => ({
      sessionId: 'ses_rent_1',
      token: `DFAP1.dev_${input.templateId}`,
      brokerUrl: 'ws://broker.test/tunnel',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  const reportMeterEvent = vi.fn(async () => ({ id: 'mev_rent_1' }));
  const terminateSession = vi.fn(opts.terminateSession ?? (async () => ({ state: 'ended' })));

  const deps: TwoThreadOrchestratorDeps = {
    hsm,
    marketplace: store,
    createSession,
    terminateSession,
    meter: { reportMeterEvent },
    pairKeys: new PairKeyService(MASTER),
    ...(opts.devAllowRerent ? { devAllowRerent: true } : {}),
  };
  return {
    orchestrator: new TwoThreadOrchestrator(deps),
    store,
    pairKeys: deps.pairKeys!,
    createSession,
    reportMeterEvent,
    terminateSession,
    licenseId: license.id,
  };
}

describe('TwoThreadOrchestrator — Layer 3 rent flow', () => {
  it('spools the VM with the decrypted license credential and records the rental', async () => {
    const hsm = fastHsm();
    const h = await harness(hsm);

    const result = await h.orchestrator.rentAndOrchestrate(PRINCIPAL, { licenseId: h.licenseId, hoursRequested: 2 });

    // Thread 1 got the DECRYPTED license credential (pre-boot injection input).
    expect(h.createSession).toHaveBeenCalledTimes(1);
    const [principalArg, inputArg] = h.createSession.mock.calls[0]!;
    expect((principalArg as Principal).userId).toBe(RENTEE);
    expect((inputArg as CreateSessionInput).credential).toEqual(LICENSE_CREDS);
    expect((inputArg as CreateSessionInput).templateId).toBe('tmpl_win_rdp');
    // The durable license link rides into createSession (recovery invariant).
    expect((inputArg as CreateSessionInput).licenseId).toBe(h.licenseId);

    // License is now rented to this rentee.
    const lic = await h.store.findById(h.licenseId);
    expect(lic?.status).toBe('rented');
    expect(lic?.currentRenteeId).toBe(RENTEE);

    // Result carries session + license + telemetry.
    expect(result.sessionId).toBe('ses_rent_1');
    expect(result.license.totalChargedUsd).toBe(9); // 4.5/hr * 2
    expect(result.telemetry.hsmKeyFingerprint).toBe('hsm-test');
    expect(result.telemetry.orchestratorTotalMs).toBeGreaterThanOrEqual(0);
    expect(result.telemetry.thread1VmSpoolingMs).toBeGreaterThanOrEqual(0);
    expect(result.telemetry.thread2CredentialRetrievalMs).toBeGreaterThanOrEqual(0);

    // Rental ledger row, with the pair-sealed credential (spec TA-4).
    const rental = await h.store.findRentalBySession('ses_rent_1');
    expect(rental).not.toBeNull();
    expect(rental!.hoursRequested).toBe(2);
    expect(rental!.totalChargedUsd).toBe(9);
    expect(rental!.meterEventId).toBe('mev_rent_1');
    expect(rental!.pairPayload).toBeDefined();
    expect(rental!.endedAt).toBeNull();

    // The pair-sealed credential opens ONLY for this owner-rentee pair.
    const opened = h.pairKeys.decrypt(OWNER, RENTEE, rental!.pairPayload!);
    expect(JSON.parse(opened)).toEqual(LICENSE_CREDS);
    expect(() => h.pairKeys.decrypt(OWNER, 'someone_else', rental!.pairPayload!)).toThrow();
  });

  it('meters the rental idempotently on license+session', async () => {
    const hsm = fastHsm();
    const h = await harness(hsm);

    await h.orchestrator.rentAndOrchestrate(PRINCIPAL, { licenseId: h.licenseId, hoursRequested: 1 });

    expect(h.reportMeterEvent).toHaveBeenCalledTimes(1);
    const input = h.reportMeterEvent.mock.calls[0]![0];
    expect(input.eventName).toBe('dfap_license_rental_hours');
    expect(input.value).toBe(4.5);
    expect(input.identifier).toContain(h.licenseId);
    expect(input.identifier).toContain('ses_rent_1');
  });

  it('404s an unknown license', async () => {
    const h = await harness(fastHsm());
    await expect(
      h.orchestrator.rentAndOrchestrate(PRINCIPAL, { licenseId: 'lic_missing', hoursRequested: 1 }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('409s a license that is already rented — fail closed by default', async () => {
    const h = await harness(fastHsm());
    await h.store.markRented(h.licenseId, 'someone_else');

    await expect(
      h.orchestrator.rentAndOrchestrate(PRINCIPAL, { licenseId: h.licenseId, hoursRequested: 1 }),
    ).rejects.toMatchObject({ statusCode: 409 });
    // No session was created for the rejected rent.
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it('re-rents a busy license ONLY when devAllowRerent is explicitly enabled', async () => {
    const h = await harness(fastHsm(), { devAllowRerent: true });
    await h.store.markRented(h.licenseId, 'someone_else');

    const result = await h.orchestrator.rentAndOrchestrate(PRINCIPAL, { licenseId: h.licenseId, hoursRequested: 1 });

    expect(result.sessionId).toBe('ses_rent_1');
    expect(h.createSession).toHaveBeenCalledTimes(1);
  });

  it('releases the license when the session ends (auto-offboarding)', async () => {
    const h = await harness(fastHsm());
    await h.orchestrator.rentAndOrchestrate(PRINCIPAL, { licenseId: h.licenseId, hoursRequested: 1 });
    expect((await h.store.findById(h.licenseId))?.status).toBe('rented');

    await h.store.completeForSession('ses_rent_1');

    expect((await h.store.findById(h.licenseId))?.status).toBe('available');
    expect((await h.store.findById(h.licenseId))?.currentRenteeId).toBeNull();
    const rental = await h.store.findRentalBySession('ses_rent_1');
    expect(rental!.endedAt).not.toBeNull();
  });

  it('compensates a failed session creation: releases the claim, no rental, no meter', async () => {
    const h = await harness(fastHsm());
    h.createSession.mockRejectedValueOnce(new Error('vm boom'));
    const recordSpy = vi.spyOn(h.store, 'recordRental');

    await expect(
      h.orchestrator.rentAndOrchestrate(PRINCIPAL, { licenseId: h.licenseId, hoursRequested: 2 }),
    ).rejects.toThrow('vm boom');

    const lic = await h.store.findById(h.licenseId);
    expect(lic?.status).toBe('available');
    expect(lic?.currentRenteeId).toBeNull();
    expect(recordSpy).not.toHaveBeenCalled();
    expect(h.reportMeterEvent).not.toHaveBeenCalled();
  });

  it('treats the atomic claim as authoritative: a lost race is a 409 and nothing is created', async () => {
    const h = await harness(fastHsm());
    // A concurrent winner slips in between the advisory pre-check and the claim.
    vi.spyOn(h.store, 'claimAvailable').mockResolvedValue(false);

    await expect(
      h.orchestrator.rentAndOrchestrate(PRINCIPAL, { licenseId: h.licenseId, hoursRequested: 1 }),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.reportMeterEvent).not.toHaveBeenCalled();
  });

  it('records the rental BEFORE metering (never meters a session with no rental)', async () => {
    const h = await harness(fastHsm());
    const recordSpy = vi.spyOn(h.store, 'recordRental');

    await h.orchestrator.rentAndOrchestrate(PRINCIPAL, { licenseId: h.licenseId, hoursRequested: 1 });

    expect(recordSpy.mock.invocationCallOrder[0]!).toBeLessThan(h.reportMeterEvent.mock.invocationCallOrder[0]!);
  });

  it('leaves a recoverable null meter id when metering fails', async () => {
    const h = await harness(fastHsm());
    h.reportMeterEvent.mockRejectedValueOnce(new Error('stripe down'));

    const result = await h.orchestrator.rentAndOrchestrate(PRINCIPAL, { licenseId: h.licenseId, hoursRequested: 1 });

    const rental = await h.store.findRentalBySession(result.sessionId);
    expect(rental).not.toBeNull();
    expect(rental!.meterEventId).toBeNull();
    expect(rental!.endedAt).toBeNull();
  });

  it('releases a claim it cannot decrypt (HSM failure) instead of wedging the license', async () => {
    const hsm = fastHsm();
    const h = await harness(hsm);
    vi.spyOn(hsm, 'decrypt').mockImplementation(() => {
      throw new Error('bad ciphertext');
    });

    await expect(
      h.orchestrator.rentAndOrchestrate(PRINCIPAL, { licenseId: h.licenseId, hoursRequested: 1 }),
    ).rejects.toThrow('bad ciphertext');

    expect((await h.store.findById(h.licenseId))?.status).toBe('available');
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it('compensates a rental-persistence failure: terminates the session, then releases the claim', async () => {
    const h = await harness(fastHsm());
    vi.spyOn(h.store, 'recordRental').mockRejectedValueOnce(new Error('rental db down'));

    await expect(
      h.orchestrator.rentAndOrchestrate(PRINCIPAL, { licenseId: h.licenseId, hoursRequested: 2 }),
    ).rejects.toThrow('rental db down');

    // The freshly created session is torn down (VM + credential)…
    expect(h.terminateSession).toHaveBeenCalledWith('ses_rent_1');
    // …and ONLY now is the claim given back.
    const lic = await h.store.findById(h.licenseId);
    expect(lic?.status).toBe('available');
    expect(lic?.currentRenteeId).toBeNull();
    // No rental row, no phantom meter, no success returned.
    expect(await h.store.findRentalBySession('ses_rent_1')).toBeNull();
    expect(h.reportMeterEvent).not.toHaveBeenCalled();
  });

  it('holds the claim when teardown cannot be confirmed terminal', async () => {
    const h = await harness(fastHsm(), { terminateSession: async () => ({ state: 'terminating' }) });
    vi.spyOn(h.store, 'recordRental').mockRejectedValueOnce(new Error('rental db down'));

    await expect(
      h.orchestrator.rentAndOrchestrate(PRINCIPAL, { licenseId: h.licenseId, hoursRequested: 1 }),
    ).rejects.toThrow('rental db down');

    expect(h.terminateSession).toHaveBeenCalledWith('ses_rent_1');
    // Fail-closed: the session may still be live, so the license stays claimed
    // (the durable session link stops the reaper from stealing it).
    expect((await h.store.findById(h.licenseId))?.status).toBe('rented');
  });

  it('holds the claim when teardown itself throws', async () => {
    const h = await harness(fastHsm(), {
      terminateSession: async () => {
        throw new Error('teardown boom');
      },
    });
    vi.spyOn(h.store, 'recordRental').mockRejectedValueOnce(new Error('rental db down'));

    await expect(
      h.orchestrator.rentAndOrchestrate(PRINCIPAL, { licenseId: h.licenseId, hoursRequested: 1 }),
    ).rejects.toThrow('rental db down');

    expect((await h.store.findById(h.licenseId))?.status).toBe('rented');
  });

  it('does not terminate a valid session when only the meter fails', async () => {
    const h = await harness(fastHsm());
    h.reportMeterEvent.mockRejectedValueOnce(new Error('stripe down'));

    const result = await h.orchestrator.rentAndOrchestrate(PRINCIPAL, { licenseId: h.licenseId, hoursRequested: 1 });

    expect(result.sessionId).toBe('ses_rent_1');
    expect(h.terminateSession).not.toHaveBeenCalled();
    expect((await h.store.findById(h.licenseId))?.status).toBe('rented');
    expect((await h.store.findRentalBySession('ses_rent_1'))?.meterEventId).toBeNull();
  });

  it('gives a concurrent rent of the same license exactly one winner', async () => {
    const h = await harness(fastHsm());
    const other: Principal = { userId: 'usr_other', orgId: 'org_2', role: 'member' };

    const [a, b] = await Promise.allSettled([
      h.orchestrator.rentAndOrchestrate(PRINCIPAL, { licenseId: h.licenseId, hoursRequested: 1 }),
      h.orchestrator.rentAndOrchestrate(other, { licenseId: h.licenseId, hoursRequested: 1 }),
    ]);

    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    const rejected = [a, b].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
    // Exactly one createSession + one rental; the loser touched nothing.
    expect(h.createSession).toHaveBeenCalledTimes(1);
    expect((await h.store.findById(h.licenseId))?.status).toBe('rented');
  });
});
