/**
 * Fastify app factory. Pure wiring: it takes a bag of already-constructed
 * services (so tests can inject fakes) and mounts the HTTP surface. All
 * business logic lives in the service functions; routes only translate
 * HTTP <-> service calls and map errors to status codes.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import type { Authenticator, Principal } from './auth/authenticator.js';
import type { CreateSessionInput, CreateSessionResult } from './sessions/create-session.js';
import type { EndReason, EndSessionResult } from './sessions/end-session.js';
import type { SessionRecord } from './ports.js';
import type { WebhookResult } from './billing/webhook.js';

import type { MarketplaceStore, SoftwareLicense, SoftwareCategory } from './marketplace/license-store.js';
import type { TwoThreadOrchestrator } from './orchestrator/two-thread-orchestrator.js';
import type { HsmService } from './crypto/hsm-rsa.js';
import type { GuestProvisioningService } from './guest/guest-provisioning.js';

export interface ApiTemplate {
  id: string;
  name: string;
  os: 'windows' | 'linux';
  recording: boolean;
}

/** Fresh, single-use connect handle minted on read while a session is connectable. */
export interface SessionConnectHandle {
  /** Opaque DFAP1 capability token. Never carries host/credential (ADR-002). */
  token: string;
  /** Broker WebSocket base URL the client appends its tunnel path to. */
  brokerUrl: string;
  /** ISO expiry of `token`. */
  expiresAt: string;
}

/** A session row plus an optional freshly-minted connect handle. */
export type SessionView = SessionRecord & { connect?: SessionConnectHandle };

export interface ApiServices {
  authenticator: Authenticator;
  listTemplates?(principal: Principal): Promise<ApiTemplate[]>;
  createSession(principal: Principal, input: CreateSessionInput): Promise<CreateSessionResult>;
  endSession(sid: string, reason: EndReason, actor: string | null): Promise<EndSessionResult>;
  getSession(sid: string): Promise<SessionView | null>;
  handleWebhook(rawBody: Buffer, signature: string): Promise<WebhookResult>;
  marketplace?: MarketplaceStore;
  orchestrator?: TwoThreadOrchestrator;
  hsm?: HsmService;
  /**
   * Guest credential provisioning (audit C3 / M8). Absent ⇒ the endpoint fails
   * closed with 503. The service verifies instance identity itself; it does NOT
   * go through the user authenticator (a booting guest has no user).
   */
  guestProvisioning?: GuestProvisioningService;
}

const FALLBACK_TEMPLATES: ApiTemplate[] = [
  { id: 'tmpl_linux_dev', name: 'Ubuntu 22.04 LTS (DevBox)', os: 'linux', recording: false },
  { id: 'tmpl_win_rdp', name: 'Windows Server 2022 (Standard)', os: 'windows', recording: true },
];

const VALID_END_REASONS: ReadonlySet<string> = new Set<EndReason>([
  'user',
  'idle_timeout',
  'max_duration',
  'admin',
  'error',
  'spot_interruption',
  'orphan_reaped',
]);

function statusOf(err: unknown): number {
  const code = (err as { statusCode?: unknown })?.statusCode;
  return typeof code === 'number' ? code : 500;
}

/** Client-safe view of a session — never the connect token or credential. */
function publicSession(s: SessionView) {
  return {
    id: s.id,
    orgId: s.orgId,
    userId: s.userId,
    templateId: s.templateId,
    instanceId: s.instanceId,
    state: s.state,
    requestedAt: s.requestedAt,
    readyAt: s.readyAt,
    connectedAt: s.connectedAt,
    endedAt: s.endedAt,
    endReason: s.endReason,
    billableSeconds: s.billableSeconds,
    // Fresh single-use connect handle, present only while connectable. This is
    // the ONLY way the browser learns how to reach its session; it carries no
    // host, port, username or password (docs/security.md, Guarantee 2).
    ...(s.connect !== undefined ? { connect: s.connect } : {}),
  };
}

export interface BuildAppOptions {
  logger?: boolean;
  /**
   * Exact browser origins allowed to make credentialed CORS requests. Defaults
   * to none: an unapproved origin receives no `Access-Control-Allow-Origin` and
   * the browser blocks it. The API never reflects an arbitrary `Origin` and
   * never pairs `*` with credentials (audit finding C4).
   */
  corsAllowedOrigins?: string[];
}

export function buildApp(services: ApiServices, opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  const allowedOrigins = new Set(opts.corsAllowedOrigins ?? []);

  // Centralized error mapping. 5xx never leaks internal detail.
  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'Unhandled request error');
    const status = statusOf(err);
    const body = status >= 500 ? { error: 'internal_error', detail: (err as Error).message } : { error: (err as Error).message };
    reply.code(status).send(body);
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
      reply.header(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-DisFAP-User, X-DisFAP-Org, stripe-signature',
      );
      reply.header('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') {
      reply.code(204).send();
      return reply;
    }
  });

  // Mount API endpoints under a router plugin to serve both with and without '/api' prefix
  const registerRoutes = async (instance: FastifyInstance) => {
    instance.get('/healthz', async () => ({ status: 'ok' }));

    // --- GET /templates -------------------------------------------------------
    instance.get('/templates', async (req: FastifyRequest) => {
      const principal = await services.authenticator.authenticate(req);
      if (services.listTemplates) {
        const templates = await services.listTemplates(principal);
        if (templates.length > 0) return templates;
      }
      return FALLBACK_TEMPLATES;
    });

    // --- GET /marketplace/licenses (Layer 1) --------------------------------
    // Authenticated catalog: `ownerName` and availability are tenant-identifying,
    // so browsing requires a valid principal. Credentials are never returned
    // (only the HSM key fingerprint) — see the mapping below.
    instance.get('/marketplace/licenses', async (req: FastifyRequest) => {
      await services.authenticator.authenticate(req);
      const query = (req.query ?? {}) as { category?: string };
      if (!services.marketplace) {
        return [];
      }
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
        hsmKeyFingerprint: lic.encryptedCredentials.keyFingerprint,
      }));
    });

    // --- POST /marketplace/licenses (Layer 1 + Layer 2) ---------------------
    instance.post('/marketplace/licenses', async (req: FastifyRequest, reply: FastifyReply) => {
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
        credentials?: { username: string; password?: string; privateKey?: string };
      };

      if (!body.softwareName || typeof body.softwareName !== 'string') {
        return reply.code(400).send({ error: 'softwareName is required' });
      }
      if (!body.credentials || !body.credentials.username) {
        return reply.code(400).send({ error: 'credentials with username required' });
      }

      // Layer 2: Encrypt credentials immediately using HSM RSA-4096
      const encrypted = services.hsm.encrypt(JSON.stringify(body.credentials));

      const license = await services.marketplace.create(principal.userId, {
        softwareName: body.softwareName,
        version: typeof body.version === 'string' ? body.version : '1.0',
        category: (body.category as SoftwareCategory) ?? 'productivity',
        description: typeof body.description === 'string' ? body.description : '',
        os: body.os === 'windows' ? 'windows' : 'linux',
        hourlyRateUsd: typeof body.hourlyRateUsd === 'number' ? body.hourlyRateUsd : 5.0,
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

    // --- POST /marketplace/rent (Layer 3 Two-Thread Orchestration) ----------
    instance.post('/marketplace/rent', async (req: FastifyRequest, reply: FastifyReply) => {
      const principal = await services.authenticator.authenticate(req);
      if (!services.orchestrator) {
        return reply.code(503).send({ error: 'Two-thread orchestrator unavailable' });
      }
      const body = (req.body ?? {}) as { licenseId?: unknown; hoursRequested?: unknown };
      if (!body.licenseId || typeof body.licenseId !== 'string') {
        return reply.code(400).send({ error: 'licenseId is required' });
      }

      const clientIp = req.ip;
      const uaRaw = req.headers['user-agent'];
      const clientUa = Array.isArray(uaRaw) ? uaRaw[0] : uaRaw;

      const result = await services.orchestrator.rentAndOrchestrate(principal, {
        licenseId: body.licenseId,
        hoursRequested: typeof body.hoursRequested === 'number' ? body.hoursRequested : 1,
        ...(clientIp ? { clientIp } : {}),
        ...(clientUa ? { clientUa } : {}),
      });

      return reply.code(201).send(result);
    });

    // --- POST /marketplace/licenses/:id/release ------------------------------
    // Object-level authorization: ONLY the license owner may restore a
    // rented/paused license to `available`. The previous "or any admin/owner"
    // bypass accepted a role from a different tenant (a cross-tenant hole) and
    // is removed — licenses carry no org, so no role can be safely scoped to
    // this object. Session ends release automatically; this covers manual
    // offboarding by the owner.
    instance.post('/marketplace/licenses/:id/release', async (req: FastifyRequest, reply: FastifyReply) => {
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

    // --- POST /sessions -------------------------------------------------------
    instance.post('/sessions', async (req: FastifyRequest, reply: FastifyReply) => {
      const principal = await services.authenticator.authenticate(req);
      const body = (req.body ?? {}) as { templateId?: unknown };
      if (typeof body.templateId !== 'string' || body.templateId === '') {
        return reply.code(400).send({ error: 'templateId is required' });
      }
      const clientIp = req.ip;
      const uaRaw = req.headers['user-agent'];
      const clientUa = Array.isArray(uaRaw) ? uaRaw[0] : uaRaw;
      const result = await services.createSession(principal, {
        templateId: body.templateId,
        ...(clientIp ? { clientIp } : {}),
        ...(clientUa ? { clientUa } : {}),
      });
      return reply.code(201).send(result);
    });

    // Shared handler for terminating a session
    const handleEndSession = async (req: FastifyRequest, reply: FastifyReply, explicitReason?: string) => {
      const principal = await services.authenticator.authenticate(req);
      const { id } = req.params as { id: string };
      const requested = explicitReason ?? 'user';
      const reason: EndReason =
        VALID_END_REASONS.has(requested) && (principal.role === 'admin' || principal.role === 'owner')
          ? (requested as EndReason)
          : 'user';

      const existing = await services.getSession(id);
      if (!existing) return reply.code(404).send({ error: 'session not found' });
      if (existing.orgId !== principal.orgId) return reply.code(403).send({ error: 'forbidden' });

      const result = await services.endSession(id, reason, principal.userId);
      return reply.code(200).send(result);
    };

    // --- POST /sessions/:id/end ----------------------------------------------
    instance.post('/sessions/:id/end', async (req: FastifyRequest, reply: FastifyReply) => {
      const body = (req.body ?? {}) as { reason?: unknown };
      const requested = typeof body.reason === 'string' ? body.reason : undefined;
      return handleEndSession(req, reply, requested);
    });

    // --- DELETE /sessions/:id ------------------------------------------------
    instance.delete('/sessions/:id', async (req: FastifyRequest, reply: FastifyReply) => {
      return handleEndSession(req, reply, 'user');
    });

    // --- GET /sessions/:id ----------------------------------------------------
    instance.get('/sessions/:id', async (req: FastifyRequest, reply: FastifyReply) => {
      const principal = await services.authenticator.authenticate(req);
      const { id } = req.params as { id: string };
      const session = await services.getSession(id);
      if (!session) return reply.code(404).send({ error: 'session not found' });
      if (session.orgId !== principal.orgId) return reply.code(403).send({ error: 'forbidden' });
      return reply.send(publicSession(session));
    });

    // --- POST /internal/guest/provision (audit C3 / M8) -----------------------
    // Server-to-server: a booting guest proves its EC2 instance identity (an
    // AWS-signed document) and receives its session credential ONCE. This does
    // NOT use the user authenticator — a booting guest has no user; the signed
    // instance identity document IS the authentication, and the server-side
    // instance→session binding is the authorization. The body is never logged.
    instance.post('/internal/guest/provision', async (req: FastifyRequest, reply: FastifyReply) => {
      if (!services.guestProvisioning) {
        return reply.code(503).send({ error: 'guest provisioning disabled' });
      }
      const body = (req.body ?? {}) as { document?: unknown; signature?: unknown };
      if (typeof body.document !== 'string' || typeof body.signature !== 'string') {
        return reply.code(400).send({ error: 'document and signature are required' });
      }
      const pkg = await services.guestProvisioning.provision({ document: body.document, signature: body.signature });
      return reply.code(200).send(pkg);
    });

    // --- POST /billing/webhook -----------------------------------------------
    instance.register(async (billing) => {
      billing.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
        done(null, body);
      });
      billing.post('/billing/webhook', async (req: FastifyRequest, reply: FastifyReply) => {
        const sigRaw = req.headers['stripe-signature'];
        const signature = Array.isArray(sigRaw) ? sigRaw[0] : sigRaw;
        if (!signature) return reply.code(400).send({ error: 'missing stripe-signature' });
        const raw = req.body as Buffer;
        const result = await services.handleWebhook(raw, signature);
        return reply.code(200).send(result);
      });
    });
  };

  // Register routes at both root prefix and /api prefix
  app.register(registerRoutes);
  app.register(registerRoutes, { prefix: '/api' });

  return app;
}
