/**
 * Fastify app factory — pure wiring.
 *
 * It takes a bag of already-constructed services (so tests inject fakes),
 * installs the cross-cutting concerns (error translation, CORS) and mounts the
 * HTTP surface. All business logic lives in the service functions; route
 * modules only translate HTTP ↔ service calls and map errors to status codes.
 *
 * Adding an endpoint: write it in `http/routes/<area>.ts` and register that
 * module in `registerRoutes` below. Do not add handlers here.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import type { ApiServices, BuildAppOptions } from './http/contracts.js';
import { isClientError } from './http/errors.js';
import {
  DEFAULT_RATE_LIMITS,
  FixedWindowRateLimiter,
  classifyRequest,
  rateLimitSubject,
} from './http/rate-limit.js';
import { registerBillingRoutes } from './http/routes/billing.js';
import { registerGuestProvisioningRoutes } from './http/routes/guest-provisioning.js';
import { registerHealthRoutes } from './http/routes/health.js';
import { registerMarketplaceRoutes } from './http/routes/marketplace.js';
import { registerSessionRoutes } from './http/routes/sessions.js';
import { registerTemplateRoutes } from './http/routes/templates.js';

// Re-exported so existing importers (`server.ts`, tests) keep working; the
// definitions now live with the routes that use them.
export type {
  ApiServices,
  ApiTemplate,
  BuildAppOptions,
  SessionConnectHandle,
  SessionView,
} from './http/contracts.js';

/** Headers the browser is allowed to send on a credentialed cross-origin call. */
const ALLOWED_REQUEST_HEADERS = 'Content-Type, Authorization, X-DFAP-User, X-DFAP-Org, Stripe-Signature';

export function buildApp(services: ApiServices, opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    // Every request body this API accepts is a small JSON object (a template id,
    // a rental request, an instance-identity document). A large cap is not
    // needed anywhere, so keep it tight and let Fastify reject oversized bodies
    // before a handler allocates anything.
    bodyLimit: opts.bodyLimitBytes ?? 128 * 1024,
    // Set only when the API is reachable exclusively through the edge proxy,
    // which overwrites `X-Forwarded-For`. `req.ip` then names the real client,
    // which is what audit records and rate-limit buckets key on.
    trustProxy: opts.trustProxy ?? false,
  });
  const allowedOrigins = new Set(opts.corsAllowedOrigins ?? []);
  const rateLimit =
    opts.rateLimits === false
      ? undefined
      : new FixedWindowRateLimiter({ ...DEFAULT_RATE_LIMITS, ...(opts.rateLimits ?? {}) });

  // Centralized error mapping. A 4xx message is the caller's actionable answer;
  // a 5xx body is generic, because internal detail (driver text, hostnames,
  // SQL) is logged, never returned. 4xx are logged as structured security
  // events (status/route/method/client) — never with the Authorization header
  // or a body, and never with a stack, which for a rejection is just noise.
  app.setErrorHandler((err, req, reply) => {
    if (isClientError(err)) {
      const statusCode = (err as { statusCode: number }).statusCode;
      req.log.warn(
        {
          statusCode,
          method: req.method,
          // Route pattern (not the concrete URL) so ids never reach the log.
          route: req.routeOptions?.url ?? 'unmatched',
          client: req.ip,
          reason: (err as Error).name,
        },
        'request rejected',
      );
      reply.code(statusCode).send({ error: (err as Error).message });
      return;
    }
    req.log.error({ err }, 'Unhandled request error');
    reply.code(500).send({ error: 'internal_error' });
  });

  // Every response is per-principal JSON. `no-store` keeps a browser, a proxy,
  // or a service worker from retaining a session view that may contain a live
  // single-use connect handle; `nosniff` stops content-type confusion.
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });

  // CORS: exact allowlist only. A request from any other origin gets no
  // `Access-Control-Allow-Origin`, so a credentialed cross-origin caller is
  // blocked by the browser rather than by a reflected-header illusion.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && allowedOrigins.has(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      reply.header('Access-Control-Allow-Headers', ALLOWED_REQUEST_HEADERS);
      reply.header('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') {
      reply.code(204).send();
      return reply;
    }
    if (rateLimit) {
      const decision = rateLimit.check(classifyRequest(req.method, req.url), rateLimitSubject(req.ip));
      if (!decision.allowed) {
        req.log.warn(
          { method: req.method, route: req.routeOptions?.url ?? 'unmatched', client: req.ip, limit: decision.limit },
          'rate limit exceeded',
        );
        reply.header('Retry-After', String(decision.retryAfterS));
        reply.code(429).send({ error: 'rate_limited' });
        return reply;
      }
    }
  });

  // Mounted at both the root and under '/api' so a reverse proxy that strips or
  // preserves the prefix works either way. Route definitions are shared, not
  // duplicated.
  const registerRoutes = async (instance: FastifyInstance) => {
    registerHealthRoutes(instance);
    registerTemplateRoutes(instance, services);
    registerMarketplaceRoutes(instance, services);
    registerSessionRoutes(instance, services);
    registerGuestProvisioningRoutes(instance, services);
    registerBillingRoutes(instance, services);
  };

  app.register(registerRoutes);
  app.register(registerRoutes, { prefix: '/api' });

  return app;
}
