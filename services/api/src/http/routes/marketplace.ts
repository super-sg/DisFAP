import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ApiServices } from '../contracts.js';
import { MAX_RENTAL_HOURS } from '../contracts.js';
import type { SoftwareCategory } from '../../marketplace/license-store.js';
import { requestContext } from '../request-context.js';

export function registerMarketplaceRoutes(app: FastifyInstance, services: ApiServices): void {
  // --- GET /marketplace/licenses -------------------------------------------
  // Authenticated catalog: `ownerName` and availability are tenant-identifying,
  // so browsing requires a valid principal. Credentials are never returned
  // (only the HSM key fingerprint).
  app.get('/marketplace/licenses', async (req: FastifyRequest) => {
    await services.authenticator.authenticate(req);
    const query = (req.query ?? {}) as { category?: string };
    if (!services.marketplace) return [];
    const licenses = await services.marketplace.listAvailable(query.category);
    return licenses.map((lic) => ({
      id: lic.id,
      softwareName: lic.softwareName,
      version: lic.version,
      category: lic.category,
      description: lic.description,
      os: lic.os,
      hourlyRateUsd: lic.hourlyRateUsd,
      ownerName: lic.ownerName,
      status: lic.status,
      maxDurationHours: lic.maxDurationHours ?? null,
      hsmKeyFingerprint: lic.encryptedCredentials.keyFingerprint,
    }));
  });

  // --- GET /marketplace/licenses/mine --------------------------------------
  // Owner dashboard. Scoped by the authenticated principal; a client cannot ask
  // for another owner's listings. Credentials are never included.
  app.get('/marketplace/licenses/mine', async (req: FastifyRequest) => {
    const principal = await services.authenticator.authenticate(req);
    if (!services.marketplace) return [];
    const [licenses, rentals] = await Promise.all([
      services.marketplace.listByOwner(principal.userId),
      services.marketplace.listRentalsByOwner(principal.userId),
    ]);
    const rentalByLicense = new Map<string, (typeof rentals)[number]>();
    for (const rental of rentals) {
      if (rental.endedAt === null) rentalByLicense.set(rental.licenseId, rental);
    }
    return licenses.map((lic) => {
      const activeRental = rentalByLicense.get(lic.id);
      return {
        id: lic.id,
        softwareName: lic.softwareName,
        version: lic.version,
        category: lic.category,
        description: lic.description,
        os: lic.os,
        hourlyRateUsd: lic.hourlyRateUsd,
        maxDurationHours: lic.maxDurationHours ?? null,
        status: lic.status,
        ownerName: lic.ownerName,
        createdAt: lic.createdAt,
        activeRental: activeRental
          ? {
              id: activeRental.id,
              renteeId: activeRental.renteeId,
              sessionId: activeRental.sessionId,
              hoursRequested: activeRental.hoursRequested,
              totalChargedUsd: activeRental.totalChargedUsd,
              startedAt: activeRental.startedAt,
            }
          : null,
      };
    });
  });

  // --- POST /marketplace/licenses ------------------------------------------
  app.post('/marketplace/licenses', async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = await services.authenticator.authenticate(req);
    if (!services.marketplace || !services.hsm) {
      return reply.code(503).send({ error: 'Marketplace or HSM service unavailable' });
    }
    const body = (req.body ?? {}) as {
      softwareName?: unknown;
      version?: unknown;
      category?: unknown;
      description?: unknown;
      os?: unknown;
      hourlyRateUsd?: unknown;
      maxDurationHours?: unknown;
      credentials?: { username?: unknown; password?: unknown; privateKey?: unknown; demoOnly?: unknown };
    };

    if (typeof body.softwareName !== 'string' || body.softwareName === '') {
      return reply.code(400).send({ error: 'softwareName is required' });
    }
    if (body.softwareName.length > 200) {
      return reply.code(400).send({ error: 'softwareName is too long' });
    }
    if (!body.credentials || typeof body.credentials.username !== 'string' || body.credentials.username === '') {
      return reply.code(400).send({ error: 'credentials with username required' });
    }
    // Bound the credential material: the API seals whatever it is given, so an
    // unbounded blob is both a storage-abuse vector and a sign of a wrong call.
    if (body.credentials.username.length > 128) {
      return reply.code(400).send({ error: 'credentials.username is too long' });
    }
    if (typeof body.credentials.password === 'string' && body.credentials.password.length > 1024) {
      return reply.code(400).send({ error: 'credentials.password is too long' });
    }
    if (typeof body.credentials.privateKey === 'string' && body.credentials.privateKey.length > 16_384) {
      return reply.code(400).send({ error: 'credentials.privateKey is too long' });
    }
    // `demoOnly` declares the credential a DEDICATED, throwaway demo
    // credential. It is the ONLY way a marketplace credential may be written to
    // EC2 userData by the evaluation injector; a reusable licensed password is
    // refused (fail closed). Reject a non-boolean rather than guessing.
    if (body.credentials.demoOnly !== undefined && typeof body.credentials.demoOnly !== 'boolean') {
      return reply.code(400).send({ error: 'credentials.demoOnly must be a boolean' });
    }
    // A negative or non-finite rate would invert or corrupt the rental ledger,
    // so it is rejected rather than coerced to a default.
    if (
      body.hourlyRateUsd !== undefined &&
      (typeof body.hourlyRateUsd !== 'number' ||
        !Number.isFinite(body.hourlyRateUsd) ||
        body.hourlyRateUsd <= 0 ||
        body.hourlyRateUsd > 1_000)
    ) {
      return reply.code(400).send({ error: 'hourlyRateUsd must be a number between 0 and 1000' });
    }
    if (
      body.category !== undefined &&
      !['engineering', 'design', 'development', 'data-science', 'productivity'].includes(body.category as string)
    ) {
      return reply.code(400).send({ error: 'category is not recognised' });
    }
    if (
      body.maxDurationHours !== undefined &&
      (typeof body.maxDurationHours !== 'number' ||
        !Number.isInteger(body.maxDurationHours) ||
        body.maxDurationHours < 1 ||
        body.maxDurationHours > MAX_RENTAL_HOURS)
    ) {
      return reply
        .code(400)
        .send({ error: `maxDurationHours must be an integer between 1 and ${MAX_RENTAL_HOURS}` });
    }
    if (body.os !== undefined && body.os !== 'windows' && body.os !== 'linux') {
      return reply.code(400).send({ error: "os must be 'windows' or 'linux'" });
    }
    if (typeof body.description === 'string' && body.description.length > 2_000) {
      return reply.code(400).send({ error: 'description is too long' });
    }

    // Layer 2: encrypt the credential immediately; the plaintext never leaves
    // this function and is never persisted.
    const encrypted = services.hsm.encrypt(
      JSON.stringify({
        username: body.credentials.username,
        ...(typeof body.credentials.password === 'string' ? { password: body.credentials.password } : {}),
        ...(typeof body.credentials.privateKey === 'string' ? { privateKey: body.credentials.privateKey } : {}),
        ...(body.credentials.demoOnly !== undefined ? { demoOnly: body.credentials.demoOnly } : {}),
      }),
    );

    const license = await services.marketplace.create(principal.userId, {
      softwareName: body.softwareName,
      version: typeof body.version === 'string' ? body.version : '1.0',
      category: (body.category as SoftwareCategory) ?? 'productivity',
      description: typeof body.description === 'string' ? body.description : '',
      os: body.os === 'windows' ? 'windows' : 'linux',
      hourlyRateUsd: typeof body.hourlyRateUsd === 'number' ? body.hourlyRateUsd : 5.0,
      ...(typeof body.maxDurationHours === 'number'
        ? { maxDurationHours: body.maxDurationHours }
        : {}),
      ownerName: `Owner (${principal.userId})`,
      encryptedCredentials: encrypted,
    });

    return reply.code(201).send({
      id: license.id,
      softwareName: license.softwareName,
      version: license.version,
      category: license.category,
      hourlyRateUsd: license.hourlyRateUsd,
      status: license.status,
      hsmKeyFingerprint: encrypted.keyFingerprint,
    });
  });

  // --- POST /marketplace/rent ----------------------------------------------
  app.post('/marketplace/rent', async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = await services.authenticator.authenticate(req);
    if (!services.orchestrator) {
      return reply.code(503).send({ error: 'Two-thread orchestrator unavailable' });
    }
    const body = (req.body ?? {}) as { licenseId?: unknown; hoursRequested?: unknown };
    if (typeof body.licenseId !== 'string' || body.licenseId === '') {
      return reply.code(400).send({ error: 'licenseId is required' });
    }

    // Bounded, integral, finite. A negative or infinite duration previously
    // flowed into the charge (`hourlyRate * hours`) and the lease expiry, so a
    // crafted body could bill an absurd amount or create a lease that never
    // ends. Validate at the trust boundary rather than trusting the UI.
    const hoursRequested = body.hoursRequested === undefined ? 1 : body.hoursRequested;
    if (
      typeof hoursRequested !== 'number' ||
      !Number.isInteger(hoursRequested) ||
      hoursRequested < 1 ||
      hoursRequested > MAX_RENTAL_HOURS
    ) {
      return reply
        .code(400)
        .send({ error: `hoursRequested must be an integer between 1 and ${MAX_RENTAL_HOURS}` });
    }

    // Listing-level cap chosen by the owner. Enforced before the claim/VM so an
    // over-long request is a clean 400, never a session the owner did not offer.
    const listing = services.marketplace ? await services.marketplace.findById(body.licenseId) : null;
    if (
      listing?.maxDurationHours !== null &&
      listing?.maxDurationHours !== undefined &&
      hoursRequested > listing.maxDurationHours
    ) {
      return reply
        .code(400)
        .send({ error: `this listing is available for at most ${listing.maxDurationHours} hour(s)` });
    }

    const result = await services.orchestrator.rentAndOrchestrate(principal, {
      licenseId: body.licenseId,
      hoursRequested,
      ...requestContext(req),
    });

    return reply.code(201).send(result);
  });

  // --- POST /marketplace/licenses/:id/release ------------------------------
  // Object-level authorization: ONLY the license owner may restore a
  // rented/paused license to `available`. The previous "or any admin/owner"
  // bypass accepted a role from a different tenant (a cross-tenant hole) and is
  // removed — licenses carry no org, so no role can be safely scoped to this
  // object. Session ends release automatically; this covers manual offboarding
  // by the owner.
  app.post('/marketplace/licenses/:id/release', async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = await services.authenticator.authenticate(req);
    if (!services.marketplace) {
      return reply.code(503).send({ error: 'Marketplace unavailable' });
    }
    const { id } = req.params as { id: string };
    const license = await services.marketplace.findById(id);
    if (!license) return reply.code(404).send({ error: 'license not found' });
    if (license.ownerId !== principal.userId) {
      return reply.code(403).send({ error: 'only the license owner can release a license' });
    }
    await services.marketplace.markAvailable(id);
    return reply.code(200).send({ id, status: 'available' });
  });
}
