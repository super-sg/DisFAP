import { describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';

import { buildServer } from '../src/server.js';
import type { ApiConfig } from '../src/config.js';
import type { Principal } from '../src/auth/authenticator.js';

const PRINCIPAL: Principal = { userId: 'usr_1', orgId: 'org_1', role: 'member' };

function cfg(devFallback: boolean): ApiConfig {
  return {
    env: devFallback ? 'development' : 'phase0',
    port: 0,
    databaseUrl: 'postgresql://disfap:disfap@localhost:5432/disfap?schema=public',
    signingKeys: { k1: Buffer.alloc(32, 3).toString('base64') },
    signingKid: 'k1',
    brokerUrl: 'ws://localhost:8080/tunnel',
    connectTokenTtlS: 60,
    credentialTtlS: 900,
    cloud: 'fake',
    devFallback,
    authMode: 'deny',
    corsAllowedOrigins: [],
    guestProvisioning: 'disabled',
    guestProvisioningTtlS: 900,
    guestProvisioningMaxDeliveries: 10,
  };
}

interface Behavior {
  /** workspaceTemplate.findUnique — drives the createSession template lookup. */
  templateFindUnique?: () => Promise<unknown>;
  /** session.findUnique — drives getSession/endSession. */
  sessionFindUnique?: () => Promise<unknown>;
  /** softwareLicense.findMany — drives marketplace listAvailable. */
  licenseFindMany?: () => Promise<unknown>;
}

/** A PrismaClient stand-in: only the probes below are exercised. */
function fakePrisma(b: Behavior = {}): PrismaClient {
  const unused = (name: string) => () => Promise.reject(new Error(`unused: ${name}`));
  const db = {
    session: {
      findUnique: b.sessionFindUnique ?? (async () => null),
      create: unused('session.create'),
      update: unused('session.update'),
    },
    workspaceTemplate: {
      findUnique: b.templateFindUnique ?? (async () => null),
      findMany: async () => [],
    },
    softwareLicense: {
      findMany: b.licenseFindMany ?? (async () => []),
      findUnique: async () => null,
      create: unused('softwareLicense.create'),
      update: unused('softwareLicense.update'),
      updateMany: async () => ({ count: 0 }),
    },
    licenseRental: {
      findUnique: async () => null,
      create: unused('licenseRental.create'),
      update: unused('licenseRental.update'),
    },
    $transaction: unused('$transaction'),
  };
  return db as unknown as PrismaClient;
}

const p2021 = (): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError('The table `software_licenses` does not exist', {
    code: 'P2021',
    clientVersion: '6.2.0',
  });

describe('buildServer — development fallbacks are explicit and OFF by default', () => {
  it('does NOT fabricate a session when createSession genuinely fails (flag off)', async () => {
    const built = buildServer(
      cfg(false),
      fakePrisma({ templateFindUnique: () => Promise.reject(new Error('relation does not exist')) }),
    );

    await expect(built.services.createSession(PRINCIPAL, { templateId: 'tmpl_x' })).rejects.toThrow(
      'relation does not exist',
    );
  });

  it('fabricates a dev-only session when createSession fails and the flag is on', async () => {
    const built = buildServer(
      cfg(true),
      fakePrisma({ templateFindUnique: () => Promise.reject(new Error('db down')) }),
    );

    const res = await built.services.createSession(PRINCIPAL, { templateId: 'tmpl_x' });
    expect(res.sessionId).toMatch(/^ses_dev_/);
    expect(res.token).toMatch(/^DFAP1\.dev_/);
  });

  it('does NOT fabricate a teardown result when endSession fails (flag off)', async () => {
    const built = buildServer(
      cfg(false),
      fakePrisma({ sessionFindUnique: () => Promise.reject(new Error('db down')) }),
    );

    await expect(built.services.endSession('ses_x', 'user', 'usr_1')).rejects.toThrow('db down');
  });

  it('fabricates an ended result when endSession fails and the flag is on', async () => {
    const built = buildServer(
      cfg(true),
      fakePrisma({ sessionFindUnique: () => Promise.reject(new Error('db down')) }),
    );

    const res = await built.services.endSession('ses_x', 'user', 'usr_1');
    expect(res.state).toBe('ended');
    expect(res.alreadyTerminal).toBe(false);
  });

  it('returns null (not a fabricated ready session) for a nonexistent session', async () => {
    const built = buildServer(cfg(false), fakePrisma());
    await expect(built.services.getSession('ses_missing')).resolves.toBeNull();
  });

  it('propagates a genuine getSession failure (flag off)', async () => {
    const built = buildServer(
      cfg(false),
      fakePrisma({ sessionFindUnique: () => Promise.reject(new Error('db down')) }),
    );

    await expect(built.services.getSession('ses_x')).rejects.toThrow('db down');
  });

  it('does NOT degrade the marketplace on a missing migration (flag off)', async () => {
    const built = buildServer(
      cfg(false),
      fakePrisma({ licenseFindMany: () => Promise.reject(p2021()) }),
    );

    await expect(built.services.marketplace!.listAvailable()).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
  });

  it('degrades to the seeded catalog on a missing migration when the flag is on', async () => {
    const built = buildServer(
      cfg(true),
      fakePrisma({ licenseFindMany: () => Promise.reject(p2021()) }),
    );

    const list = await built.services.marketplace!.listAvailable();
    expect(list.length).toBeGreaterThan(0);
  });
});

describe('buildServer — inbound authentication composition', () => {
  it('composes a fail-closed authenticator by default (no IdP wired)', async () => {
    const built = buildServer(cfg(false), fakePrisma());
    await expect(
      built.services.authenticator.authenticate({
        headers: { 'x-dfap-user': 'usr_1', 'x-dfap-org': 'org_1', 'x-dfap-role': 'admin' },
      }),
    ).rejects.toThrow(/authentication is not configured/);
  });

  it('composes the dev-header authenticator only when explicitly configured, and never trusts the role header', async () => {
    const built = buildServer({ ...cfg(true), authMode: 'dev-header' }, fakePrisma());
    const principal = await built.services.authenticator.authenticate({
      headers: { 'x-dfap-user': 'usr_dev', 'x-dfap-org': 'org_dev', 'x-dfap-role': 'admin' },
    });
    // No DB membership; dev fallback yields least privilege, forged role ignored.
    expect(principal.role).toBe('member');
  });

  it('composes the OIDC authenticator when provider configuration is present', async () => {
    const oidcCfg: ApiConfig = {
      ...cfg(false),
      authMode: 'oidc',
      oidc: {
        issuer: 'https://login.example.com/',
        audience: 'https://api.example.com',
        algorithms: ['RS256'],
        clockToleranceS: 5,
        tokenUseClaim: 'token_use',
        tokenUseValue: 'access',
        requireTokenUse: false,
        jwksCacheMaxAgeS: 600,
        jwksCooldownS: 30,
      },
    };
    const built = buildServer(oidcCfg, fakePrisma());
    // OidcAuthenticator requires a bearer token; no header ⇒ 401 before any DB.
    await expect(built.services.authenticator.authenticate({ headers: {} })).rejects.toThrow(/missing bearer token/);
  });
});
