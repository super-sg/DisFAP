import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ApiServices } from '../contracts.js';

/**
 * `POST /billing/webhook` — provider callback.
 *
 * Signature verification (not a user principal) is the authentication, and it
 * must run over the *raw* bytes: a re-serialized JSON body would not verify.
 * The buffer parser is therefore installed inside an encapsulated plugin
 * scope, so it applies to this route only and the rest of the API keeps the
 * normal JSON parser.
 */
export function registerBillingRoutes(app: FastifyInstance, services: ApiServices): void {
  app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    scope.post('/billing/webhook', async (req: FastifyRequest, reply: FastifyReply) => {
      const sigRaw = req.headers['stripe-signature'];
      const signature = Array.isArray(sigRaw) ? sigRaw[0] : sigRaw;
      if (!signature) return reply.code(400).send({ error: 'missing stripe-signature' });
      if (!Buffer.isBuffer(req.body)) {
        // Unreachable with the parser above, but a wrong body type must fail
        // closed rather than reach signature verification as a string.
        return reply.code(400).send({ error: 'invalid body' });
      }
      const result = await services.handleWebhook(req.body, signature);
      return reply.code(200).send(result);
    });
  });
}
