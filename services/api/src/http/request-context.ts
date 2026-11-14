import type { FastifyRequest } from 'fastify';

/**
 * Request metadata persisted with a session for abuse diagnosis and cleanup.
 *
 * Kept in one place because both "start a session" and "rent a license" write
 * the same two columns; letting them drift would make the audit trail
 * inconsistent for no reason.
 */
export interface RequestContext {
  clientIp?: string;
  clientUa?: string;
}

export function requestContext(req: FastifyRequest): RequestContext {
  const uaRaw = req.headers['user-agent'];
  const clientUa = Array.isArray(uaRaw) ? uaRaw[0] : uaRaw;
  return { ...(req.ip ? { clientIp: req.ip } : {}), ...(clientUa ? { clientUa } : {}) };
}
