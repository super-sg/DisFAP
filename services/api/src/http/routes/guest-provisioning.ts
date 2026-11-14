import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ApiServices } from '../contracts.js';

/**
 * `POST /internal/guest/provision` (audit C3 / M8) — server-to-server.
 *
 * A booting guest proves its EC2 instance identity with an AWS-signed document
 * and receives its session credential ONCE. This deliberately does NOT use the
 * user authenticator (a booting guest has no user): the signed instance
 * identity document is the authentication, and the server-side
 * instance→session binding is the authorization. The body is never logged.
 *
 * Fails closed with 503 when the feature is not configured.
 */
export function registerGuestProvisioningRoutes(app: FastifyInstance, services: ApiServices): void {
  app.post('/internal/guest/provision', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!services.guestProvisioning) {
      return reply.code(503).send({ error: 'guest provisioning disabled' });
    }
    const body = (req.body ?? {}) as { document?: unknown; signature?: unknown };
    if (typeof body.document !== 'string' || typeof body.signature !== 'string') {
      return reply.code(400).send({ error: 'document and signature are required' });
    }
    const pkg = await services.guestProvisioning.provision({
      document: body.document,
      signature: body.signature,
    });
    return reply.code(200).send(pkg);
  });
}
