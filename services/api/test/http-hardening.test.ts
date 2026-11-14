import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { Authenticator, Principal } from '../src/auth/authenticator.js';
import { InMemoryMarketplaceStore } from '../src/marketplace/license-store.js';
import type { SessionRecord } from '../src/ports.js';
import type { ApiServices } from '../src/http/contracts.js';

/**
 * Hardening tests for the HTTP trust boundary itself: who may hold a session's
 * connect handle, who may end it, what a 5xx is allowed to say, and how a
 * rental duration is validated. These are transport-level guarantees, so they
 * use a minimal service double rather than a real database.
 */
function servicesWith(principal: Principal): ApiServices {
  const sessions = new Map<string, SessionRecord>();
  const marketplace = new InMemoryMarketplaceStore();

  const session = (id: string): SessionRecord => ({
    id,
    orgId: 'org_test',
    userId: 'usr_owner',
    templateId: 'tmpl_linux_dev',
    instanceId: 'inst_1',
    licenseId: null,
    state: 'ready',
    requestedAt: new Date(),
    readyAt: new Date(),
    firstPixelAt: null,
    connectedAt: null,
    disconnectedAt: null,
    disconnectDeadlineAt: null,
    endedAt: null,
    endReason: null,
    billableSeconds: null,
    vaultCredPath: null,
    clientIp: null,
    clientUa: null,
  });

  sessions.set('ses_owned', session('ses_owned'));

  return {
    authenticator: { authenticate: async () => principal } satisfies Authenticator,
    createSession: async () => ({
      sessionId: 'ses_new',
      token: 'DFAP1.tok',
      brokerUrl: 'ws://localhost:8080',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    endSession: async (sid, reason) => {
      const row = sessions.get(sid);
      if (row) row.state = 'ended';
      return {
        sessionId: sid,
        state: 'ended',
        endReason: reason,
        alreadyTerminal: false,
        endedAt: new Date(),
        billableSeconds: 0,
      } as never;
    },
    getSession: async (sid) => sessions.get(sid) ?? null,
    handleWebhook: async () => ({ received: true, duplicate: false, type: 'payment_intent.succeeded' }),
    marketplace,
  };
}

const owner: Principal = { userId: 'usr_owner', orgId: 'org_test', role: 'member' };

describe('session access control', () => {
  it('lets the renter read their own session', async () => {
    const app = buildApp(servicesWith(owner));
    const res = await app.inject({ method: 'GET', url: '/api/sessions/ses_owned' });
    expect(res.statusCode).toBe(200);
  });

  it('denies a same-org peer a read (the connect handle would impersonate the renter)', async () => {
    const app = buildApp(servicesWith({ userId: 'usr_peer', orgId: 'org_test', role: 'member' }));
    const res = await app.inject({ method: 'GET', url: '/api/sessions/ses_owned' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
  });

  it('denies a cross-tenant caller without revealing the session', async () => {
    const app = buildApp(servicesWith({ userId: 'usr_owner', orgId: 'org_other', role: 'owner' }));
    const res = await app.inject({ method: 'GET', url: '/api/sessions/ses_owned' });
    expect(res.statusCode).toBe(403);
  });

  it('lets the renter or a tenant admin end a session, but not a peer', async () => {
    const peer = buildApp(servicesWith({ userId: 'usr_peer', orgId: 'org_test', role: 'member' }));
    expect((await peer.inject({ method: 'DELETE', url: '/api/sessions/ses_owned' })).statusCode).toBe(403);

    const admin = buildApp(servicesWith({ userId: 'usr_admin', orgId: 'org_test', role: 'admin' }));
    const ended = await admin.inject({ method: 'DELETE', url: '/api/sessions/ses_owned' });
    expect(ended.statusCode).toBe(200);
    expect(ended.json()).toMatchObject({ sessionId: 'ses_owned', state: 'ended' });
  });
});

describe('error exposure', () => {
  it('never returns internal detail in a 5xx body', async () => {
    const services = servicesWith(owner);
    services.getSession = async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
    };
    const app = buildApp(services);

    const res = await app.inject({ method: 'GET', url: '/api/sessions/ses_owned' });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error' });
    expect(res.body).not.toContain('10.0.0.5');
    expect(res.body).not.toContain('ECONNREFUSED');
  });

  it('still describes a client error so the caller can act on it', async () => {
    const app = buildApp(servicesWith(owner));
    const res = await app.inject({ method: 'POST', url: '/api/sessions', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'templateId is required' });
  });
});

describe('transport hardening', () => {
  it('marks every response no-store and nosniff', async () => {
    const app = buildApp(servicesWith(owner));
    const res = await app.inject({ method: 'GET', url: '/api/sessions/ses_owned' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');

    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.headers['cache-control']).toBe('no-store');
  });

  it('rejects an oversized body before a handler runs', async () => {
    const app = buildApp(servicesWith(owner), { bodyLimitBytes: 1024 });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { templateId: 'x'.repeat(4096) },
    });
    expect(res.statusCode).toBe(413);
  });
});

describe('abuse limits', () => {
  const tight = {
    global: { windowMs: 60_000, max: 1000 },
    'session-create': { windowMs: 60_000, max: 2 },
    'guest-provision': { windowMs: 60_000, max: 1000 },
  } as const;

  it('throttles session creation per client after the configured cap', async () => {
    const app = buildApp(servicesWith(owner), { rateLimits: tight });
    for (let i = 0; i < 2; i += 1) {
      const ok = await app.inject({ method: 'POST', url: '/api/sessions', payload: { templateId: 'tmpl_linux_dev' } });
      expect(ok.statusCode).toBe(201);
    }
    const blocked = await app.inject({ method: 'POST', url: '/api/sessions', payload: { templateId: 'tmpl_linux_dev' } });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: 'rate_limited' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('counts the /api and root mount as the same bucket (no prefix bypass)', async () => {
    const app = buildApp(servicesWith(owner), { rateLimits: tight });
    await app.inject({ method: 'POST', url: '/api/sessions', payload: { templateId: 'tmpl_linux_dev' } });
    await app.inject({ method: 'POST', url: '/sessions', payload: { templateId: 'tmpl_linux_dev' } });
    const blocked = await app.inject({ method: 'POST', url: '/api/sessions', payload: { templateId: 'tmpl_linux_dev' } });
    expect(blocked.statusCode).toBe(429);
  });

  it('does not spend the budget on CORS preflights', async () => {
    const app = buildApp(servicesWith(owner), { rateLimits: tight, corsAllowedOrigins: ['https://ok.test'] });
    for (let i = 0; i < 5; i += 1) {
      const preflight = await app.inject({ method: 'OPTIONS', url: '/api/sessions', headers: { origin: 'https://ok.test' } });
      expect(preflight.statusCode).toBe(204);
    }
    const post = await app.inject({ method: 'POST', url: '/api/sessions', payload: { templateId: 'tmpl_linux_dev' } });
    expect(post.statusCode).toBe(201);
  });

  it('leaves ordinary reads unlimited by the session-create rule', async () => {
    const app = buildApp(servicesWith(owner), { rateLimits: tight });
    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/api/sessions/ses_owned' });
      expect(res.statusCode).toBe(200);
    }
  });

  it('keys the bucket on the proxy-appended address, not a client-supplied prefix', async () => {
    // Caddy overwrites X-Forwarded-For with the real peer. If a forged header
    // ever reached the API, trusting exactly one hop still selects the LAST
    // entry (the one the proxy appended), never the attacker's leftmost value.
    const app = buildApp(servicesWith(owner), {
      trustProxy: (_address: string, hop: number) => hop === 0,
      rateLimits: { ...tight, 'session-create': { windowMs: 60_000, max: 1 } },
    });
    const first = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'x-forwarded-for': '9.9.9.9, 5.5.5.5' },
      payload: { templateId: 'tmpl_linux_dev' },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'x-forwarded-for': '8.8.8.8, 5.5.5.5' },
      payload: { templateId: 'tmpl_linux_dev' },
    });
    expect(second.statusCode).toBe(429);
  });
});

describe('rental request validation', () => {
  /** The route 503s when the feature is unconfigured, so the test supplies one. */
  function rentable(principal: Principal) {
    const services = servicesWith(principal);
    services.orchestrator = {
      rentAndOrchestrate: async () => {
        throw new Error('the orchestrator must not be reached by an invalid request');
      },
    } as never;
    return buildApp(services);
  }

  it.each([0, -1, 1.5, 25, 1e9, '2', null])(
    'rejects hoursRequested=%s with 400 before touching the orchestrator',
    async (hoursRequested) => {
      const res = await rentable(owner).inject({
        method: 'POST',
        url: '/api/marketplace/rent',
        payload: { licenseId: 'lic_x', hoursRequested },
      });
      expect(res.statusCode).toBe(400);
    },
  );

  it('requires a non-empty licenseId', async () => {
    const res = await rentable(owner).inject({
      method: 'POST',
      url: '/api/marketplace/rent',
      payload: { hoursRequested: 1 },
    });
    expect(res.statusCode).toBe(400);
  });
});
