/**
 * End-to-end authentication boundary test.
 *
 * This is the strongest practical integration we can run without a real IdP or
 * cloud: a **real** local OIDC provider issues a **real** RS256 access token via
 * the Authorization Code + PKCE flow, and the **real** HTTP API (real
 * `JoseAccessTokenVerifier` + `OidcAuthenticator` + Fastify app) verifies and
 * authorizes it. It proves the full browser→provider→API path, plus the negative
 * guarantees: no token, unmapped identity, tampered token, and client-supplied
 * identity/role headers can never confer access or privilege.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp, type ApiServices } from '../src/app.js';
import { OidcAuthenticator } from '../src/auth/oidc.js';
import { JoseAccessTokenVerifier } from '../src/auth/jwks.js';
import type { Principal } from '../src/auth/authenticator.js';
import type { IdentityRepo, MembershipRepo, SessionRecord } from '../src/ports.js';
import { obtainAccessToken, pkceChallenge, OidcTestProvider } from './support/oidc-test-provider.js';

const AUDIENCE = 'https://api.disfap.test';
const CLIENT_ID = 'disfap-web';
const REDIRECT_URI = 'http://localhost:5173/auth/callback';
const MAPPED_SUBJECT = 'idp-subject-e2e';
const MAPPED_USER = 'usr_e2e';
const ORG = 'org_e2e';

const provider = new OidcTestProvider({ audience: AUDIENCE, subject: MAPPED_SUBJECT, tokenTtlS: 300 });

const identities: IdentityRepo = {
  resolve: async (issuer, subject) =>
    issuer === provider.issuer && subject === MAPPED_SUBJECT ? MAPPED_USER : null,
};

const memberships: MembershipRepo = {
  roleOf: async () => 'member',
  resolveMembership: async (userId, orgHint) =>
    userId === MAPPED_USER && (orgHint === undefined || orgHint === ORG) ? { orgId: ORG, role: 'member' } : null,
};

/** Captures the principal the API resolved, so tests can inspect it directly. */
const seen: { last: Principal | null } = { last: null };

const crossTenantSession: SessionRecord = {
  id: 'ses_other_org',
  orgId: 'org_someone_else',
  userId: 'usr_other',
  templateId: 'tmpl_x',
  instanceId: null,
  licenseId: null,
  state: 'ready',
  requestedAt: new Date(),
  readyAt: new Date(),
  firstPixelAt: null,
  connectedAt: null,
  disconnectedAt: null,
  endedAt: null,
  endReason: null,
  billableSeconds: null,
  vaultCredPath: null,
  clientIp: null,
  clientUa: null,
};

function makeApp() {
  const verifier = new JoseAccessTokenVerifier({
    issuer: provider.issuer,
    audience: AUDIENCE,
    jwksUrl: provider.jwksUrl,
    algorithms: ['RS256'],
    clockToleranceS: 0,
    tokenUseClaim: 'token_use',
    tokenUseValue: 'access',
    requireTokenUse: true,
    jwksCacheMaxAgeS: 0,
    jwksCooldownS: 0,
  });
  const authenticator = new OidcAuthenticator({ verifier, identities, memberships });

  const services: ApiServices = {
    authenticator,
    listTemplates: async () => [],
    createSession: async (principal) => {
      seen.last = principal;
      return {
        sessionId: 'ses_e2e',
        token: 'DFAP1.e2e',
        brokerUrl: 'ws://broker.test/tunnel',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    endSession: async (sid, reason) => ({
      sessionId: sid,
      state: 'ended',
      endReason: reason,
      alreadyTerminal: false,
      endedAt: new Date(),
      billableSeconds: 1,
    }),
    getSession: async (sid) => (sid === crossTenantSession.id ? crossTenantSession : null),
    handleWebhook: async () => ({ received: true, duplicate: false, type: 'test' }),
    marketplace: { listAvailable: async () => [], findById: async () => null } as never,
  };

  return buildApp(services, { corsAllowedOrigins: [] });
}

let app: ReturnType<typeof makeApp>;
let validToken: string;

beforeAll(async () => {
  await provider.start();
  app = makeApp();
  await app.ready();
  const { accessToken } = await obtainAccessToken(provider, {
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
  });
  validToken = accessToken;
});

afterAll(async () => {
  await app.close();
  await provider.stop();
});

describe('OIDC end-to-end — real provider token → real API', () => {
  it('accepts a real PKCE-issued access token for an authenticated tenant resource', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/marketplace/licenses',
      headers: { authorization: `Bearer ${validToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('rejects a request with no bearer token (fail closed)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/marketplace/licenses' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a valid token whose subject is not mapped to a DisFAP user', async () => {
    const { accessToken } = await obtainAccessToken(provider, {
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      subject: 'idp-unmapped-subject',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/marketplace/licenses',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a tampered token (bad signature)', async () => {
    const parts = validToken.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${(parts[2] ?? '').slice(0, -2)}xx`;
    const res = await app.inject({
      method: 'GET',
      url: '/api/marketplace/licenses',
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('OIDC end-to-end — headers/claims cannot override verified identity', () => {
  it('ignores x-dfap-user / x-dfap-org / x-dfap-role and resolves identity from the token', async () => {
    seen.last = null;
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: {
        authorization: `Bearer ${validToken}`,
        'x-dfap-user': 'usr_attacker',
        'x-dfap-org': 'org_attacker',
        'x-dfap-role': 'admin',
      },
      payload: { templateId: 'tmpl_x' },
    });
    expect(res.statusCode).toBe(201);
    expect(seen.last).toMatchObject({ userId: MAPPED_USER, orgId: ORG, role: 'member' });
  });

  it('forbids reading a session in another organization (tenant scoping)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${crossTenantSession.id}`,
      headers: { authorization: `Bearer ${validToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('OIDC end-to-end — PKCE and issuer trust are enforced', () => {
  it('rejects a token exchange whose PKCE verifier does not match the challenge (no token issued)', async () => {
    // Authorize with the S256 challenge for the *correct* verifier, then present
    // a *different* verifier at the token endpoint.
    const authorize = new URL(`${provider.issuer}/authorize`);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', CLIENT_ID);
    authorize.searchParams.set('redirect_uri', REDIRECT_URI);
    authorize.searchParams.set('scope', 'openid');
    authorize.searchParams.set('state', 'pkce-test');
    authorize.searchParams.set('code_challenge', pkceChallenge('the-correct-verifier'));
    authorize.searchParams.set('code_challenge_method', 'S256');

    const authRes = await fetch(authorize, { redirect: 'manual' });
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;

    const tokenRes = await fetch(`${provider.issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: 'not-the-correct-verifier',
      }),
    });
    expect(tokenRes.status).toBe(400);
    const body = (await tokenRes.json()) as { access_token?: string; error?: string };
    expect(body.access_token).toBeUndefined();
    expect(body.error).toBe('invalid_grant');
  });

  it('does not trust discovery for a mismatched issuer at the API', async () => {
    // A verifier pointed at a *different* issuer must reject this provider's
    // tokens even though the JWKS is reachable.
    const verifier = new JoseAccessTokenVerifier({
      issuer: 'https://not-the-provider.example/',
      audience: AUDIENCE,
      jwksUrl: provider.jwksUrl,
      algorithms: ['RS256'],
      clockToleranceS: 0,
      tokenUseClaim: 'token_use',
      tokenUseValue: 'access',
      requireTokenUse: true,
      jwksCacheMaxAgeS: 0,
      jwksCooldownS: 0,
    });
    await expect(verifier.verify(validToken)).rejects.toThrow();
  });
});
