import type { FastifyInstance } from 'fastify';

/**
 * Liveness probe. Mounted at both `/healthz` and `/api/healthz`, and
 * deliberately unauthenticated: a load balancer cannot present a principal.
 * It reports only that the process is serving HTTP — dependency health
 * (database, broker, cloud) is intentionally not asserted here, because a
 * failing dependency must not evict every instance from behind the balancer.
 */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/healthz', async () => ({ status: 'ok' }));
}
