import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  describe('loadConfig — AWS launch contract', () => {
    const aws = {
      CLOUD_PROVIDER: 'aws',
      AWS_REGION: 'ap-south-1',
      AWS_LAUNCH_TEMPLATE_ID: 'lt-0123456789abcdef0',
      AWS_SESSION_AMI_ID: 'ami-0123456789abcdef0',
      AWS_SESSION_INSTANCE_TYPE: 't4g.small',
      AWS_SESSION_ARCHITECTURE: 'arm64',
    };

    it('requires an explicit non-placeholder AMI and architecture-compatible instance type', () => {
      const cfg = loadConfig(baseEnv(aws));
      expect(cfg.aws).toMatchObject({
        region: 'ap-south-1',
        sessionAmiId: 'ami-0123456789abcdef0',
        sessionInstanceType: 't4g.small',
        sessionArchitecture: 'arm64',
      });
    });

    it('rejects a placeholder AMI', () => {
      expect(() => loadConfig(baseEnv({ ...aws, AWS_SESSION_AMI_ID: 'ami-phase0-placeholder' }))).toThrow(
        /real ami.*placeholder/,
      );
    });

    it('rejects an architecture mismatch', () => {
      expect(() =>
        loadConfig(baseEnv({ ...aws, AWS_SESSION_INSTANCE_TYPE: 't3.small', AWS_SESSION_ARCHITECTURE: 'arm64' })),
      ).toThrow(/incompatible/);
    });
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

describe('loadConfig — Vault identity and transport', () => {
  const PAIR = Buffer.alloc(32, 7).toString('base64');
  const prod = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
    baseEnv({
      DFAP_ENV: 'production',
      DFAP_CREDENTIAL_KEY_FILE: '/run/secrets/dfap.pem',
      DFAP_PAIR_MASTER_KEY: PAIR,
      ...extra,
    });

  it('has no Vault at all when VAULT_ADDR is absent', () => {
    expect(loadConfig(baseEnv()).vault).toBeUndefined();
  });

  it('parses a static token (fallback identity)', () => {
    const cfg = loadConfig(baseEnv({ VAULT_ADDR: 'https://vault.internal:8200/', VAULT_TOKEN: 's.tok' }));
    expect(cfg.vault).toEqual({
      addr: 'https://vault.internal:8200',
      mount: 'secret',
      auth: { kind: 'token', token: 's.tok' },
    });
  });

  it('prefers AppRole: role_id + secret_id become a refreshable identity', () => {
    const cfg = loadConfig(
      baseEnv({ VAULT_ADDR: 'https://vault.internal:8200', VAULT_APPROLE_ROLE_ID: 'r', VAULT_APPROLE_SECRET_ID: 's' }),
    );
    expect(cfg.vault?.auth).toEqual({ kind: 'approle', roleId: 'r', secretId: 's' });
  });

  it('reads the token / secret_id from files (keeps them out of the env)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dfap-vault-'));
    try {
      const tokenFile = join(dir, 'token');
      writeFileSync(tokenFile, 's.from-file\n', { mode: 0o600 });
      const cfg = loadConfig(baseEnv({ VAULT_ADDR: 'https://vault.internal:8200', VAULT_TOKEN_FILE: tokenFile }));
      expect(cfg.vault?.auth).toEqual({ kind: 'token', token: 's.from-file' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an address with no credential instead of making anonymous calls', () => {
    expect(() => loadConfig(baseEnv({ VAULT_ADDR: 'https://vault.internal:8200' }))).toThrow(/no Vault credential/);
  });

  it('refuses a static token and AppRole at the same time', () => {
    expect(() =>
      loadConfig(
        baseEnv({ VAULT_ADDR: 'https://v', VAULT_TOKEN: 't', VAULT_APPROLE_ROLE_ID: 'r', VAULT_APPROLE_SECRET_ID: 's' }),
      ),
    ).toThrow(/not both/);
  });

  it('requires role_id and secret_id together', () => {
    expect(() => loadConfig(baseEnv({ VAULT_ADDR: 'https://v', VAULT_APPROLE_ROLE_ID: 'r' }))).toThrow(
      /VAULT_APPROLE_SECRET_ID/,
    );
    expect(() => loadConfig(baseEnv({ VAULT_ADDR: 'https://v', VAULT_APPROLE_SECRET_ID: 's' }))).toThrow(
      /VAULT_APPROLE_ROLE_ID/,
    );
  });

  it('refuses both inline and file forms of one secret', () => {
    expect(() =>
      loadConfig(baseEnv({ VAULT_ADDR: 'https://v', VAULT_TOKEN: 't', VAULT_TOKEN_FILE: '/run/secrets/x' })),
    ).toThrow(/not both/);
  });

  it('fails boot when the secret file is missing or empty', () => {
    expect(() => loadConfig(baseEnv({ VAULT_ADDR: 'https://v', VAULT_TOKEN_FILE: '/nonexistent/x' }))).toThrow(
      /could not be read/,
    );
    const dir = mkdtempSync(join(tmpdir(), 'dfap-vault-'));
    try {
      const empty = join(dir, 'empty');
      writeFileSync(empty, '\n');
      expect(() => loadConfig(baseEnv({ VAULT_ADDR: 'https://v', VAULT_TOKEN_FILE: empty }))).toThrow(/is empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires https in production unless cleartext is explicitly acknowledged', () => {
    expect(() => loadConfig(prod({ VAULT_ADDR: 'http://vault:8200', VAULT_TOKEN: 't' }))).toThrow(/https/);
    const cfg = loadConfig(
      prod({ VAULT_ADDR: 'http://vault:8200', VAULT_TOKEN: 't', VAULT_ALLOW_HTTP: 'true' }),
    );
    expect(cfg.vault?.addr).toBe('http://vault:8200');
  });

  it('rejects a non-http(s) address and a multi-segment mount', () => {
    expect(() => loadConfig(baseEnv({ VAULT_ADDR: 'file:///tmp/vault', VAULT_TOKEN: 't' }))).toThrow(/http/);
    expect(() => loadConfig(baseEnv({ VAULT_ADDR: 'https://v', VAULT_TOKEN: 't', VAULT_MOUNT: 'a/b' }))).toThrow(
      /VAULT_MOUNT/,
    );
  });

  it('bounds the credential TTL (a secret must not live in Vault for a week)', () => {
    expect(() => loadConfig(baseEnv({ CREDENTIAL_TTL_S: '30' }))).toThrow(/CREDENTIAL_TTL_S/);
    expect(() => loadConfig(baseEnv({ CREDENTIAL_TTL_S: '604800' }))).toThrow(/CREDENTIAL_TTL_S/);
    expect(loadConfig(baseEnv({ CREDENTIAL_TTL_S: '3600' })).credentialTtlS).toBe(3600);
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

describe('loadConfig — readiness tuning', () => {
  it('defaults to a 600s budget on the RDP port', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.readyTimeoutS).toBe(600);
    expect(cfg.readyProbePort).toBe(3389);
  });

  it('accepts an explicit budget and probe port', () => {
    const cfg = loadConfig(baseEnv({ DFAP_READY_TIMEOUT_S: '1200', DFAP_READY_PROBE_PORT: '3390' }));
    expect(cfg.readyTimeoutS).toBe(1200);
    expect(cfg.readyProbePort).toBe(3390);
  });

  it('fails boot on a non-numeric, fractional or out-of-range value', () => {
    for (const bad of ['abc', '0', '29', '3601', '12.5', '-1']) {
      expect(() => loadConfig(baseEnv({ DFAP_READY_TIMEOUT_S: bad }))).toThrow(/DFAP_READY_TIMEOUT_S/);
    }
    for (const bad of ['0', '65536', 'rdp']) {
      expect(() => loadConfig(baseEnv({ DFAP_READY_PROBE_PORT: bad }))).toThrow(/DFAP_READY_PROBE_PORT/);
    }
  });

  it('passes the optional evaluation SSH key through only when set', () => {
    expect(loadConfig(baseEnv()).evalSshPublicKey).toBeUndefined();
    expect(loadConfig(baseEnv({ DFAP_EVAL_SSH_PUBKEY: 'ssh-ed25519 AAAA test' })).evalSshPublicKey).toBe(
      'ssh-ed25519 AAAA test',
    );
  });
});

describe('loadConfig — session disconnect lifecycle', () => {
  it('defaults to a 30s reconnect grace and a 15s reaper cadence', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.sessionDisconnectGraceS).toBe(30);
    expect(cfg.sessionReaperIntervalS).toBe(15);
  });

  it('accepts explicit bounded values', () => {
    const cfg = loadConfig(
      baseEnv({ DFAP_SESSION_DISCONNECT_GRACE_S: '120', DFAP_SESSION_REAPER_INTERVAL_S: '60' }),
    );
    expect(cfg.sessionDisconnectGraceS).toBe(120);
    expect(cfg.sessionReaperIntervalS).toBe(60);
  });

  it('fails boot when either window is out of range or non-integer', () => {
    for (const bad of ['0', '4', '601', '12.5', 'abc']) {
      expect(() => loadConfig(baseEnv({ DFAP_SESSION_DISCONNECT_GRACE_S: bad }))).toThrow(
        /DFAP_SESSION_DISCONNECT_GRACE_S/,
      );
    }
    for (const bad of ['0', '4', '301', '2.5', 'soon']) {
      expect(() => loadConfig(baseEnv({ DFAP_SESSION_REAPER_INTERVAL_S: bad }))).toThrow(
        /DFAP_SESSION_REAPER_INTERVAL_S/,
      );
    }
  });
});

describe('loadConfig — signing keys', () => {
  it('refuses a key shorter than 32 bytes, matching the broker', () => {
    expect(() =>
      loadConfig(
        baseEnv({ DFAP_SIGNING_KEYS: `k1:${Buffer.alloc(16, 1).toString('base64')}`, DFAP_SIGNING_KID: 'k1' }),
      ),
    ).toThrow(/fewer than 32 bytes/);
  });

  it('refuses a signing kid that is not in the keyring', () => {
    expect(() => loadConfig(baseEnv({ DFAP_SIGNING_KID: 'nope' }))).toThrow(/not present in DFAP_SIGNING_KEYS/);
  });
});
