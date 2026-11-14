import type { FastifyInstance, FastifyRequest } from 'fastify';

import { FALLBACK_TEMPLATES, type ApiServices } from '../contracts.js';

/**
 * `GET /templates` — the workspace catalog a caller may launch.
 *
 * Authenticated: the catalog is tenant-scoped, so it is not public. When the
 * deployment supplies `listTemplates` and returns entries, those win; otherwise
 * the built-in fallback keeps a bare development node usable.
 */
export function registerTemplateRoutes(app: FastifyInstance, services: ApiServices): void {
  app.get('/templates', async (req: FastifyRequest) => {
    const principal = await services.authenticator.authenticate(req);
    if (services.listTemplates) {
      const templates = await services.listTemplates(principal);
      if (templates.length > 0) return templates;
    }
    return FALLBACK_TEMPLATES;
  });
}
