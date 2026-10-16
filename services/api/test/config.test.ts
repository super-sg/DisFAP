import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

/** Minimal valid environment; each test overrides only what it probes. */
function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DFAP_SIGNING_KEYS: `k1:${Buffer.alloc(32, 1).toString('base64')}`,
    DFAP_SIGNING_KID: 'k1',
    DATABASE_URL: 'postgresql://disfap:disfap@localhost:5432/disfap?schema=public',
    BROKER_URL: 'ws://localhost:8080/tunnel',
    ...extra,
  };
}

describe('loadConfig — DFAP_DEV_FALLBACK gating', () => {
  it('defaults devFallback to false (fail closed)', () => {
    expect(loadConfig(baseEnv()).devFallback).toBe(false);
  });

  it('enables devFallback only for an explicit true', () => {
    expect(loadConfig(baseEnv({ DFAP_DEV_FALLBACK: 'true' })).devFallback).toBe(true);
    expect(loadConfig(baseEnv({ DFAP_DEV_FALLBACK: 'false' })).devFallback).toBe(false);
  });

  it('rejects a non-boolean value rather than guessing', () => {
    expect(() => loadConfig(baseEnv({ DFAP_DEV_FALLBACK: 'yes' }))).toThrow(/DFAP_DEV_FALLBACK/);
  });

  it('refuses to enable devFallback in production', () => {
    expect(() => loadConfig(baseEnv({ DFAP_DEV_FALLBACK: 'true', DFAP_ENV: 'production' }))).toThrow(
      /must not be enabled in production/,
    );
    expect(() => loadConfig(baseEnv({ DFAP_DEV_FALLBACK: 'true', NODE_ENV: 'production' }))).toThrow(
      /must not be enabled in production/,
    );
  });
});

describe('loadConfig — authentication mode (fail closed by default)', () => {
  it('defaults authMode to deny', () => {
    expect(loadConfig(baseEnv()).authMode).toBe('deny');
  });

  it('accepts the explicit dev-header mode outside production', () => {
    expect(loadConfig(baseEnv({ DFAP_AUTH_MODE: 'dev-header' })).authMode).toBe('dev-header');
  });

  it('rejects an unknown auth mode', () => {
    expect(() => loadConfig(baseEnv({ DFAP_AUTH_MODE: 'stub' }))).toThrow(/DFAP_AUTH_MODE/);
  });

  it('refuses the dev-header mode in production', () => {
    expect(() => loadConfig(baseEnv({ DFAP_AUTH_MODE: 'dev-header', DFAP_ENV: 'production' }))).toThrow(
      /must not be used in production/,
    );
    expect(() => loadConfig(baseEnv({ DFAP_AUTH_MODE: 'dev-header', NODE_ENV: 'production' }))).toThrow(
      /must not be used in production/,
    );
  });
});

describe('loadConfig — CORS allowlist (exact origins only)', () => {
  it('defaults to no allowed origins (deny unapproved browsers)', () => {
    expect(loadConfig(baseEnv()).corsAllowedOrigins).toEqual([]);
  });

  it('parses a comma-separated exact allowlist', () => {
    expect(
      loadConfig(baseEnv({ DFAP_CORS_ALLOWED_ORIGINS: 'https://app.example.com, http://localhost:5173' }))
        .corsAllowedOrigins,
    ).toEqual(['https://app.example.com', 'http://localhost:5173']);
  });

  it('rejects a wildcard origin', () => {
    expect(() => loadConfig(baseEnv({ DFAP_CORS_ALLOWED_ORIGINS: '*' }))).toThrow(/wildcards are not allowed/);
    expect(() => loadConfig(baseEnv({ DFAP_CORS_ALLOWED_ORIGINS: 'https://*.example.com' }))).toThrow(
      /wildcards are not allowed/,
    );
  });

  it('rejects a malformed or non-origin value', () => {
    expect(() => loadConfig(baseEnv({ DFAP_CORS_ALLOWED_ORIGINS: 'not a url' }))).toThrow(/not a valid URL/);
    expect(() => loadConfig(baseEnv({ DFAP_CORS_ALLOWED_ORIGINS: 'https://app.example.com/path' }))).toThrow(
      /bare scheme:\/\/host/,
    );
  });
});

describe('loadConfig — OIDC provider configuration', () => {
  const oidcEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
    baseEnv({
      DFAP_AUTH_MODE: 'oidc',
      DFAP_OIDC_ISSUER: 'https://login.example.com/',
      DFAP_OIDC_AUDIENCE: 'https://api.example.com',
      ...extra,
    });

  it('accepts the oidc mode with issuer + audience and applies safe defaults', () => {
    const cfg = loadConfig(oidcEnv());
    expect(cfg.authMode).toBe('oidc');
    expect(cfg.oidc).toMatchObject({
      issuer: 'https://login.example.com/',
      audience: 'https://api.example.com',
      algorithms: ['RS256'],
      tokenUseClaim: 'token_use',
      tokenUseValue: 'access',
      requireTokenUse: false,
    });
    expect(cfg.oidc?.jwksUrl).toBeUndefined();
  });

  it('fails closed when issuer or audience is missing', () => {
    expect(() => loadConfig(baseEnv({ DFAP_AUTH_MODE: 'oidc', DFAP_OIDC_AUDIENCE: 'x' }))).toThrow(
      /DFAP_OIDC_ISSUER/,
    );
    expect(() => loadConfig(baseEnv({ DFAP_AUTH_MODE: 'oidc', DFAP_OIDC_ISSUER: 'https://login.example.com/' }))).toThrow(
      /DFAP_OIDC_AUDIENCE/,
    );
  });

  it('rejects a non-http(s) issuer or JWKS URL', () => {
    expect(() => loadConfig(oidcEnv({ DFAP_OIDC_ISSUER: 'ftp://login.example.com/' }))).toThrow(/http\(s\)/);
    expect(() => loadConfig(oidcEnv({ DFAP_OIDC_JWKS_URL: 'not-a-url' }))).toThrow(/absolute URL/);
  });

  it("rejects 'none' in the algorithm allowlist", () => {
    expect(() => loadConfig(oidcEnv({ DFAP_OIDC_ALGORITHMS: 'RS256,none' }))).toThrow(/must not include 'none'/);
  });

  it('parses an explicit JWKS URL, org claim and access-token typ', () => {
    const cfg = loadConfig(
      oidcEnv({
        DFAP_OIDC_JWKS_URL: 'https://login.example.com/jwks',
        DFAP_OIDC_ORG_CLAIM: 'org_id',
        DFAP_OIDC_ACCESS_TOKEN_TYP: 'at+jwt',
        DFAP_OIDC_REQUIRE_TOKEN_USE: 'true',
      }),
    );
    expect(cfg.oidc).toMatchObject({
      jwksUrl: 'https://login.example.com/jwks',
      orgClaim: 'org_id',
      accessTokenTyp: 'at+jwt',
      requireTokenUse: true,
    });
  });

  it('leaves oidc undefined when the mode is not oidc', () => {
    expect(loadConfig(baseEnv({ DFAP_OIDC_ISSUER: 'https://login.example.com/' })).oidc).toBeUndefined();
  });
});

describe('loadConfig — durable key & provider requirements', () => {
  const PAIR = Buffer.alloc(32, 7).toString('base64');
  const prod = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
    baseEnv({ DFAP_ENV: 'production', ...extra });

  it('does not require key config outside production', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.credentialKey).toBeUndefined();
    expect(cfg.pairMasterKey).toBeUndefined();
  });

  it('parses the credential-key env (file / retired PEM list)', () => {
    const cfg = loadConfig(
      baseEnv({ DFAP_CREDENTIAL_KEY_FILE: '/run/secrets/dfap.pem', DFAP_CREDENTIAL_KEY_RETIRED_PEMS: 'aaa, bbb' }),
    );
    expect(cfg.credentialKey).toEqual({ file: '/run/secrets/dfap.pem', retiredPems: ['aaa', 'bbb'] });
  });

  it('rejects a pair master that decodes to fewer than 32 bytes', () => {
    expect(() => loadConfig(baseEnv({ DFAP_PAIR_MASTER_KEY: Buffer.alloc(8, 1).toString('base64') }))).toThrow(
      /at least 32 bytes/,
    );
  });

  it('requires a durable credential key in production', () => {
    expect(() => loadConfig(prod())).toThrow(/durable credential key/);
  });

  it('requires the pair master in production', () => {
    expect(() => loadConfig(prod({ DFAP_CREDENTIAL_KEY_PEM: 'x' }))).toThrow(/DFAP_PAIR_MASTER_KEY/);
  });

  it('requires Vault in production (no in-memory fallback)', () => {
    expect(() => loadConfig(prod({ DFAP_CREDENTIAL_KEY_PEM: 'x', DFAP_PAIR_MASTER_KEY: PAIR }))).toThrow(
      /VAULT_ADDR/,
    );
  });

  it('accepts production once every durable provider is configured', () => {
    const cfg = loadConfig(
      prod({
        DFAP_CREDENTIAL_KEY_FILE: '/run/secrets/dfap.pem',
        DFAP_PAIR_MASTER_KEY: PAIR,
        VAULT_ADDR: 'https://vault.internal:8200',
        VAULT_TOKEN: 'tok',
      }),
    );
    expect(cfg.credentialKey?.file).toBe('/run/secrets/dfap.pem');
    expect(cfg.pairMasterKey).toBe(PAIR);
    expect(cfg.vault?.addr).toBe('https://vault.internal:8200');
  });
});

describe('loadConfig — guest credential provisioning (audit C3 / M8)', () => {
  const PAIR = Buffer.alloc(32, 7).toString('base64');

  it('defaults to disabled with a bounded TTL and delivery cap', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.guestProvisioning).toBe('disabled');
    expect(cfg.guestProvisioningTtlS).toBe(900);
    expect(cfg.guestProvisioningMaxDeliveries).toBe(10);
    expect(cfg.guestIdentityCerts).toBeUndefined();
  });

  it('rejects an unknown mode rather than guessing', () => {
    expect(() => loadConfig(baseEnv({ DFAP_GUEST_PROVISIONING: 'ssm' }))).toThrow(/must be 'disabled' or 'instance-identity'/);
  });

  it('refuses to enable instance-identity without cert material', () => {
    expect(() => loadConfig(baseEnv({ DFAP_GUEST_PROVISIONING: 'instance-identity' }))).toThrow(/CERT_FILE or .*CERT_PEM/);
  });

  it('parses cert PEM / cert file outside production', () => {
    const withPem = loadConfig(baseEnv({ DFAP_GUEST_PROVISIONING: 'instance-identity', DFAP_GUEST_IDENTITY_CERT_PEM: 'PEM' }));
    expect(withPem.guestProvisioning).toBe('instance-identity');
    expect(withPem.guestIdentityCerts).toEqual({ pem: 'PEM' });

    const withFile = loadConfig(
      baseEnv({
        DFAP_GUEST_PROVISIONING: 'instance-identity',
        DFAP_GUEST_IDENTITY_CERT_FILE: '/etc/dfap/aws-identity.pem',
        DFAP_GUEST_PROVISIONING_TTL_S: '120',
        DFAP_GUEST_PROVISIONING_MAX_DELIVERIES: '3',
      }),
    );
    expect(withFile.guestIdentityCerts).toEqual({ file: '/etc/dfap/aws-identity.pem' });
    expect(withFile.guestProvisioningTtlS).toBe(120);
    expect(withFile.guestProvisioningMaxDeliveries).toBe(3);
  });

  it('REFUSES instance-identity in production — no false claim until AWS is validated', () => {
    const prodEnv = baseEnv({
      DFAP_ENV: 'production',
      DFAP_CREDENTIAL_KEY_FILE: '/run/secrets/dfap.pem',
      DFAP_PAIR_MASTER_KEY: PAIR,
      VAULT_ADDR: 'https://vault.internal:8200',
      VAULT_TOKEN: 'tok',
      DFAP_GUEST_PROVISIONING: 'instance-identity',
      DFAP_GUEST_IDENTITY_CERT_FILE: '/etc/dfap/aws-identity.pem',
    });
    expect(() => loadConfig(prodEnv)).toThrow(/not production-enabled/);
  });
});
