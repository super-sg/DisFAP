import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ApiServices } from '../contracts.js';
import type { EndReason } from '../../sessions/end-session.js';
import { publicSession, controlDenial, readDenial } from '../session-view.js';
import { requestContext } from '../request-context.js';

const VALID_END_REASONS: ReadonlySet<string> = new Set<EndReason>([
  'user',
  'idle_timeout',
  'max_duration',
  'admin',
  'error',
  'spot_interruption',
  'orphan_reaped',
]);

export function registerSessionRoutes(app: FastifyInstance, services: ApiServices): void {
  // --- POST /sessions -------------------------------------------------------
  app.post('/sessions', async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = await services.authenticator.authenticate(req);
    const body = (req.body ?? {}) as { templateId?: unknown };
    if (typeof body.templateId !== 'string' || body.templateId === '') {
      return reply.code(400).send({ error: 'templateId is required' });
    }
    const result = await services.createSession(principal, {
      templateId: body.templateId,
      ...requestContext(req),
    });
    return reply.code(201).send(result);
  });

  // --- GET /sessions/:id ----------------------------------------------------
  // Returns a freshly-minted single-use connect handle while connectable.
  // Reading is restricted to the renter of record: the handle authenticates as
  // that user at the broker, so sharing it would be account sharing.
  //
  // Authorization runs BEFORE the handle is minted: no Vault wrap operation and
  // no capability is produced for a caller who is about to receive a 403.
  app.get('/sessions/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = await services.authenticator.authenticate(req);
    const { id } = req.params as { id: string };
    const session = await services.getSession(id);
    if (!session) return reply.code(404).send({ error: 'session not found' });
    const denial = readDenial(principal, session);
    if (denial) return reply.code(denial.status).send({ error: denial.error });

    // A Vault hiccup must not make an otherwise healthy session look missing.
    // Returning the row without a handle lets the client retry the read; the
    // broker never accepts a connection without a valid capability anyway.
    let connect = session.connect;
    if (services.issueConnectHandle) {
      try {
        connect = (await services.issueConnectHandle(session)) ?? undefined;
      } catch (err) {
        req.log.warn({ err, sessionId: session.id }, 'connect handle issuance failed; polling client will retry');
        connect = undefined;
      }
    }
    return reply.send(publicSession({ ...session, ...(connect ? { connect } : {}) }));
  });

  /** Shared handler for POST /sessions/:id/end and DELETE /sessions/:id. */
  const endSession = async (req: FastifyRequest, reply: FastifyReply, requested?: unknown) => {
    const principal = await services.authenticator.authenticate(req);
    const { id } = req.params as { id: string };

    // Only an admin/owner may attach a reason that changes bookkeeping; a
    // member-sent reason is downgraded to the honest `user`.
    const want = typeof requested === 'string' ? requested : 'user';
    const reason: EndReason =
      VALID_END_REASONS.has(want) && (principal.role === 'admin' || principal.role === 'owner')
        ? (want as EndReason)
        : 'user';

    const existing = await services.getSession(id);
    if (!existing) return reply.code(404).send({ error: 'session not found' });
    const denial = controlDenial(principal, existing);
    if (denial) return reply.code(denial.status).send({ error: denial.error });

    const result = await services.endSession(id, reason, principal.userId);
    return reply.code(200).send(result);
  };

  // --- POST /sessions/:id/end ----------------------------------------------
  app.post('/sessions/:id/end', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as { reason?: unknown };
    return endSession(req, reply, body.reason);
  });

  // --- DELETE /sessions/:id -------------------------------------------------
  app.delete('/sessions/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    return endSession(req, reply, 'user');
  });
}
