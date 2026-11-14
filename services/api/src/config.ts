/**
 * Control-plane configuration — validated from the environment once at startup,
 * fail-fast. A misconfigured control plane must never boot and silently mint
 * bad tokens or leak instances.
 *
 * The signing-key env format is deliberately identical to the broker's
 * (`DFAP_SIGNING_KEYS='kid:base64,...'`, `DFAP_SIGNING_KID=kid`) so the two
 * services can be handed the same key material.
 */

import { readFileSync } from 'node:fs';

import type { CredentialKeyConfig } from './crypto/credential-key-store.js';
import type { GuestProvisioningMode } from './guest/guest-provisioning.js';

export type CloudKind = 'fake' | 'aws';

/**
 * Which inbound-authentication adapter the control plane composes.
 *  - `deny`       — default. Reject every request: no trusted IdP is wired yet.
 *  - `dev-header` — LOCAL DEVELOPMENT ONLY. Refused in production.
 *  - `oidc`       — verify OIDC/JWT access tokens (production path). Requires
 *                   `DFAP_OIDC_ISSUER` + `DFAP_OIDC_AUDIENCE`.
 */
export type AuthMode = 'deny' | 'dev-header' | 'oidc';

/** OIDC/JWT access-token verification settings (see `auth/jwks.ts`). */
export interface OidcConfig {
  /** Exact expected `iss`. */
  issuer: string;
  /** Exact expected audience — the API's resource id, never a client id. */
  audience: string;
  /** Explicit JWKS URL; when absent, OIDC discovery at the issuer is used. */
  jwksUrl?: string;
  /** Permitted JWS algorithms; `none` is always rejected. */
  algorithms: string[];
  /** Allowed clock skew for `exp`/`nbf`, seconds. */
  clockToleranceS: number;
  /** Optional claim naming the organization (selector only). */
  orgClaim?: string;
  /** Optional required JOSE header `typ` (e.g. `at+jwt`). */
  accessTokenTyp?: string;
  /** Claim distinguishing an access token from an ID token. */
  tokenUseClaim: string;
  /** Required value of the token-use claim for an access token. */
  tokenUseValue: string;
  /** When true, the token-use claim must be present. */
  requireTokenUse: boolean;
  /** Max age (s) of a cached JWKS before refetch. */
  jwksCacheMaxAgeS: number;
  /** Min interval (s) between refetches on an unknown `kid`. */
  jwksCooldownS: number;
}

export interface ApiConfig {
  env: string;
  port: number;
  databaseUrl: string;

  /** base64 HMAC signing keys by kid, plus the active signing kid. */
  signingKeys: Record<string, string>;
  signingKid: string;

  /** Public WS URL clients dial to reach the broker, e.g. wss://host/tunnel. */
  brokerUrl: string;

  /** DFAP1 connect-token TTL (broker enforces 60s; kept configurable ≤60). */
  connectTokenTtlS: number;
  /** Vault TTL for a staged session credential. */
  credentialTtlS: number;
  /**
   * Bounded reconnect window after an ordinary tunnel drop, seconds. During
   * this period the VM and rental are preserved; after it the lifecycle reaper
   * ends the session through the normal teardown path.
   */
  sessionDisconnectGraceS: number;
  /** How often the session lifecycle reaper looks for expired disconnects. */
  sessionReaperIntervalS: number;

  cloud: CloudKind;
  aws?: {
    region: string;
    launchTemplateId: string;
    launchTemplateVersion?: string;
    sessionAmiId: string;
    sessionInstanceType: string;
    sessionArchitecture: 'x86_64' | 'arm64';
    /**
     * Root EBS volume size for a session instance. Sent with every
     * `RunInstances` call so the requested size is deterministic even though the
     * request's block-device mapping overrides the launch template's.
     */
    sessionVolumeGiB: number;
  };

  vault?: VaultConfig;

  /**
   * Durable credential-key provider for owner-credential sealing (Layer 2).
   * Absent means no durable key is configured — fatal in production (see the
   * guard in `loadConfig`); a non-production process uses a default dev file.
   */
  credentialKey?: CredentialKeyConfig;

  /**
   * base64 pair-key master seed (spec TA-4). Required in production; without it
   * the pair keys derive from a NON-secret dev seed and must not be trusted.
   */
  pairMasterKey?: string;

  stripe?: { apiKey: string; webhookSecret: string };

  /**
   * Opt-in ONLY development fallbacks: fabricate session/teardown results and
   * degrade the marketplace to its in-memory catalog when a database call
   * fails. Defaults to false and is refused in production, so the control
   * plane fails closed — a genuine failure is never reported as success.
   */
  devFallback: boolean;

  /**
   * Inbound-authentication adapter (see `AuthMode`). Defaults to `deny`, so a
   * deployment with no IdP serves nothing rather than trusting client-asserted
   * identity. `dev-header` is refused in production.
   */
  authMode: AuthMode;

  /** Present only when `authMode === 'oidc'`. */
  oidc?: OidcConfig;

  /**
   * Exact browser origins permitted to make credentialed CORS requests. Empty
   * (the default) denies all cross-origin browser access. The API never
   * reflects an arbitrary `Origin` and never pairs `*` with credentials.
   */
  corsAllowedOrigins: string[];

  /**
   * Guest credential provisioning mode (audit finding C3 / milestone M8).
   *  - `disabled` (default) — the guest-provisioning endpoint refuses.
   *  - `instance-identity` — verify an AWS-signed EC2 instance identity
   *    document, enforce the server-side instance→session binding, and deliver
   *    the session credential once. Requires AWS regional public-key material.
   */
  guestProvisioning: GuestProvisioningMode;

  /** AWS instance-identity regional public key material (PEM, file or inline). */
  guestIdentityCerts?: { file?: string; pem?: string };

  /** Absolute ceiling (seconds) on a provisioning window. Default 900. */
  guestProvisioningTtlS: number;

  /** Max credential deliveries per live session (idempotent retries included). */
  guestProvisioningMaxDeliveries: number;

  /**
   * Budget (seconds) for a launched VM to become GENUINELY ready: the cloud
   * reports `running` AND the gateway port accepts a connection. A session that
   * misses the budget is failed and its VM torn down — never left `allocating`.
   */
  readyTimeoutS: number;

  /** Gateway port the readiness probe dials. 3389 for RDP. */
  readyProbePort: number;

  /**
   * Optional SSH public key installed on disposable evaluation VMs for
   * operator diagnostics. Only reachable on the non-production cloud-init path;
   * production injects no login material at all.
   */
  evalSshPublicKey?: string;
}

/**
 * How the control plane authenticates to Vault.
 *
 * `approle` is preferred: role_id + secret_id buy a short-lived token that the
 * client re-mints. `token` is a static, long-lived token for platforms that
 * cannot issue a workload identity — it must still carry a least-privilege
 * policy, never a root token.
 */
export type VaultAuthConfig =
  | { kind: 'token'; token: string }
  | { kind: 'approle'; roleId: string; secretId: string };

export interface VaultConfig {
  addr: string;
  mount: string;
  auth: VaultAuthConfig;
  /** Vault Enterprise namespace (optional; OSS ignores it). */
  namespace?: string;
}

class ConfigError extends Error {}

function req(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (v === undefined || v === '') throw new ConfigError(`missing required env ${name}`);
  return v;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ConfigError(`env ${name} must be an integer, got ${JSON.stringify(v)}`);
  return n;
}

/** An integer that must also be in range — a typo fails boot instead of silently misbehaving. */
function boundedInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const n = int(env, name, fallback);
  if (n < min || n > max) {
    throw new ConfigError(`env ${name} must be between ${min} and ${max}, got ${n}`);
  }
  return n;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new ConfigError(`env ${name} must be a boolean (true/false), got ${JSON.stringify(v)}`);
}

/** Inbound-auth adapter, with the production guard for the dev header mode. */
function parseAuthMode(env: NodeJS.ProcessEnv, envName: string): AuthMode {
  const raw = env['DFAP_AUTH_MODE'] ?? 'deny';
  if (raw !== 'deny' && raw !== 'dev-header' && raw !== 'oidc') {
    throw new ConfigError(`DFAP_AUTH_MODE must be 'deny', 'dev-header' or 'oidc', got ${JSON.stringify(raw)}`);
  }
  if (raw === 'dev-header' && (envName === 'production' || env['NODE_ENV'] === 'production')) {
    throw new ConfigError('DFAP_AUTH_MODE=dev-header must not be used in production');
  }
  return raw;
}

/** An absolute http(s) URL with no query/fragment (issuer / JWKS endpoint). */
function httpUrl(env: NodeJS.ProcessEnv, name: string): string {
  const value = req(env, name);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`env ${name} must be an absolute URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ConfigError(`env ${name} must be an http(s) URL`);
  }
  if (parsed.search || parsed.hash) {
    throw new ConfigError(`env ${name} must not carry a query or fragment`);
  }
  return value;
}

/**
 * OIDC verifier settings. Required whenever `authMode === 'oidc'`: with no
 * issuer/audience the control plane cannot establish a valid token, so boot
 * fails rather than falling back to trusting anything.
 */
function parseOidc(env: NodeJS.ProcessEnv): OidcConfig {
  const algorithms = (env['DFAP_OIDC_ALGORITHMS'] ?? 'RS256')
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a !== '');
  if (algorithms.length === 0) throw new ConfigError('DFAP_OIDC_ALGORITHMS must list at least one algorithm');
  if (algorithms.some((a) => a.toLowerCase() === 'none')) {
    throw new ConfigError("DFAP_OIDC_ALGORITHMS must not include 'none'");
  }

  const cfg: OidcConfig = {
    issuer: httpUrl(env, 'DFAP_OIDC_ISSUER'),
    audience: req(env, 'DFAP_OIDC_AUDIENCE'),
    algorithms,
    clockToleranceS: int(env, 'DFAP_OIDC_CLOCK_TOLERANCE_S', 5),
    tokenUseClaim: env['DFAP_OIDC_TOKEN_USE_CLAIM'] ?? 'token_use',
    tokenUseValue: env['DFAP_OIDC_TOKEN_USE_VALUE'] ?? 'access',
    requireTokenUse: bool(env, 'DFAP_OIDC_REQUIRE_TOKEN_USE', false),
    jwksCacheMaxAgeS: int(env, 'DFAP_OIDC_JWKS_CACHE_MAX_AGE_S', 600),
    jwksCooldownS: int(env, 'DFAP_OIDC_JWKS_COOLDOWN_S', 30),
  };
  if (env['DFAP_OIDC_JWKS_URL']) cfg.jwksUrl = httpUrl(env, 'DFAP_OIDC_JWKS_URL');
  if (env['DFAP_OIDC_ORG_CLAIM']) cfg.orgClaim = req(env, 'DFAP_OIDC_ORG_CLAIM');
  if (env['DFAP_OIDC_ACCESS_TOKEN_TYP']) cfg.accessTokenTyp = req(env, 'DFAP_OIDC_ACCESS_TOKEN_TYP');
  return cfg;
}

/**
 * Exact-origin CORS allowlist. Wildcards are rejected outright (a wildcard is
 * meaningless with credentials), and entries must be bare
 * `scheme://host[:port]` origins so a typo cannot silently widen access.
 */
function parseCorsAllowedOrigins(env: NodeJS.ProcessEnv): string[] {
  const raw = env['DFAP_CORS_ALLOWED_ORIGINS'];
  if (!raw) return [];
  const origins = raw
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '');
  for (const o of origins) {
    if (o.includes('*')) {
      throw new ConfigError('DFAP_CORS_ALLOWED_ORIGINS must list exact origins; wildcards are not allowed');
    }
    let parsed: URL;
    try {
      parsed = new URL(o);
    } catch {
      throw new ConfigError(`DFAP_CORS_ALLOWED_ORIGINS entry ${JSON.stringify(o)} is not a valid URL`);
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin !== o) {
      throw new ConfigError(
        `DFAP_CORS_ALLOWED_ORIGINS entry ${JSON.stringify(o)} must be a bare scheme://host[:port] origin (no path, no trailing slash)`,
      );
    }
  }
  return origins;
}

/** True when the environment must behave as production. */
function isProductionEnv(env: NodeJS.ProcessEnv): boolean {
  const name = env['DFAP_ENV'] ?? 'phase0';
  return name === 'production' || env['NODE_ENV'] === 'production';
}

/**
 * Durable credential-key provider selection (Layer 2). Configuration only —
 * the PEM itself is validated (RSA, modulus) by the provider at construction.
 */
function parseCredentialKey(env: NodeJS.ProcessEnv): CredentialKeyConfig | undefined {
  const file = env['DFAP_CREDENTIAL_KEY_FILE'];
  const pem = env['DFAP_CREDENTIAL_KEY_PEM'];
  const retiredPems = (env['DFAP_CREDENTIAL_KEY_RETIRED_PEMS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (!file && !pem && retiredPems.length === 0) return undefined;
  return {
    ...(file ? { file } : {}),
    ...(pem ? { pem } : {}),
    retiredPems,
  };
}

/** Validated base64 pair-key master seed (≥32 bytes once decoded). */
function parsePairMasterKey(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env['DFAP_PAIR_MASTER_KEY'];
  if (!raw) return undefined;
  let seed: Buffer;
  try {
    seed = Buffer.from(raw, 'base64');
  } catch {
    throw new ConfigError('DFAP_PAIR_MASTER_KEY must be valid base64');
  }
  if (seed.length < 32) {
    throw new ConfigError('DFAP_PAIR_MASTER_KEY must decode to at least 32 bytes');
  }
  return raw;
}

/**
 * Guest credential-provisioning mode (audit C3 / M8). Fail closed:
 *  - default `disabled`;
 *  - enabling `instance-identity` requires AWS regional public-key material;
 *  - it is REFUSED in production because real AWS instance-identity verification
 *    has not been validated locally (see docs/runbooks/guest-provisioning.md).
 *    Shipping it unverified would be a false security claim.
 */
function parseGuestProvisioning(
  env: NodeJS.ProcessEnv,
  isProduction: boolean,
): { mode: GuestProvisioningMode; certs?: { file?: string; pem?: string } } {
  const raw = env['DFAP_GUEST_PROVISIONING'] ?? 'disabled';
  if (raw !== 'disabled' && raw !== 'instance-identity') {
    throw new ConfigError(`DFAP_GUEST_PROVISIONING must be 'disabled' or 'instance-identity', got ${JSON.stringify(raw)}`);
  }
  if (raw === 'disabled') return { mode: 'disabled' };

  const file = env['DFAP_GUEST_IDENTITY_CERT_FILE'];
  const pem = env['DFAP_GUEST_IDENTITY_CERT_PEM'];
  if (!file && !pem) {
    throw new ConfigError(
      'DFAP_GUEST_PROVISIONING=instance-identity requires DFAP_GUEST_IDENTITY_CERT_FILE or DFAP_GUEST_IDENTITY_CERT_PEM (the AWS regional public key)',
    );
  }
  if (isProduction) {
    throw new ConfigError(
      'DFAP_GUEST_PROVISIONING=instance-identity is not production-enabled: real AWS instance-identity verification has not been validated (see docs/runbooks/guest-provisioning.md)',
    );
  }
  return { mode: 'instance-identity', certs: { ...(file ? { file } : {}), ...(pem ? { pem } : {}) } };
}

/**
 * Read secret material from `<NAME>` or `<NAME>_FILE`.
 *
 * A file is the safer delivery channel on a container host: an environment
 * variable is visible in `docker inspect`, `/proc/<pid>/environ`, and crash
 * dumps, while a mounted secret file is not. Exactly one of the two may be set
 * (an ambiguous pair fails boot rather than guessing). The value is trimmed of
 * a trailing newline; an empty file is a configuration error, never "no auth".
 */
function secretFromEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const inline = env[name];
  const file = env[`${name}_FILE`];
  if (inline && file) {
    throw new ConfigError(`set either ${name} or ${name}_FILE, not both`);
  }
  if (file) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      throw new ConfigError(`${name}_FILE could not be read (${file})`);
    }
    if (raw.length > 8192) throw new ConfigError(`${name}_FILE is implausibly large`);
    const trimmed = raw.trim();
    if (trimmed === '') throw new ConfigError(`${name}_FILE is empty`);
    return trimmed;
  }
  if (inline && inline.trim() !== '') return inline.trim();
  return undefined;
}

/**
 * Vault connection + identity.
 *
 * Fail-closed rules:
 *  - `VAULT_ADDR` set but no credential ⇒ boot error (never an anonymous call).
 *  - a static token AND AppRole ⇒ boot error (exactly one identity).
 *  - production requires `https://` unless `VAULT_ALLOW_HTTP=true` explicitly
 *    acknowledges that Vault traffic is confined to a private bridge network.
 *  - an AppRole secret_id is only accepted with its role_id.
 */
function parseVault(env: NodeJS.ProcessEnv, isProduction: boolean): VaultConfig | undefined {
  const addr = env['VAULT_ADDR'];
  const token = secretFromEnv(env, 'VAULT_TOKEN');
  const roleId = env['VAULT_APPROLE_ROLE_ID'];
  const secretId = secretFromEnv(env, 'VAULT_APPROLE_SECRET_ID');

  if (!addr) {
    if (token || roleId || secretId) {
      throw new ConfigError('VAULT_ADDR is required when any Vault credential is configured');
    }
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(addr);
  } catch {
    throw new ConfigError('VAULT_ADDR must be an absolute http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('VAULT_ADDR must use http:// or https://');
  }
  if (isProduction && url.protocol !== 'https:' && env['VAULT_ALLOW_HTTP'] !== 'true') {
    throw new ConfigError(
      'production requires https for VAULT_ADDR (set VAULT_ALLOW_HTTP=true only for a Vault reachable solely over a private, non-routable network)',
    );
  }

  if (token && roleId) {
    throw new ConfigError('configure either VAULT_TOKEN (static) or VAULT_APPROLE_ROLE_ID/SECRET_ID (preferred), not both');
  }
  if (roleId && !secretId) throw new ConfigError('VAULT_APPROLE_ROLE_ID requires VAULT_APPROLE_SECRET_ID or VAULT_APPROLE_SECRET_ID_FILE');
  if (secretId && !roleId) throw new ConfigError('VAULT_APPROLE_SECRET_ID requires VAULT_APPROLE_ROLE_ID');
  if (!token && !roleId) {
    throw new ConfigError(
      'VAULT_ADDR is set but no Vault credential was supplied: set VAULT_APPROLE_ROLE_ID + VAULT_APPROLE_SECRET_ID(_FILE) (preferred) or VAULT_TOKEN(_FILE)',
    );
  }

  const mount = env['VAULT_MOUNT'] ?? 'secret';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(mount)) {
    throw new ConfigError('VAULT_MOUNT must be a single path segment');
  }
  const namespace = env['VAULT_NAMESPACE'];

  return {
    addr: url.origin + url.pathname.replace(/\/+$/, ''),
    mount,
    ...(namespace ? { namespace } : {}),
    auth: token
      ? { kind: 'token', token }
      : { kind: 'approle', roleId: roleId as string, secretId: secretId as string },
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const rawKeys = env['DFAP_SIGNING_KEYS'];
  if (!rawKeys) throw new ConfigError('missing required env DFAP_SIGNING_KEYS');
  const signingKeys: Record<string, string> = {};
  for (const pair of rawKeys.split(',')) {
    const [kid, b64] = pair.split(':');
    if (!kid || !b64) throw new ConfigError(`malformed DFAP_SIGNING_KEYS entry ${JSON.stringify(pair)}`);
    // The broker refuses a signing key shorter than 32 bytes (it is the HMAC
    // key). The API mints those same tokens, so it enforces the same floor
    // instead of starting with material the broker would reject.
    if (Buffer.from(b64.trim(), 'base64').length < 32) {
      throw new ConfigError(
        `DFAP_SIGNING_KEYS entry for kid ${JSON.stringify(kid.trim())} decodes to fewer than 32 bytes`,
      );
    }
    signingKeys[kid.trim()] = b64.trim();
  }
  const signingKid = req(env, 'DFAP_SIGNING_KID');
  if (!signingKeys[signingKid]) {
    throw new ConfigError(`DFAP_SIGNING_KID ${signingKid} not present in DFAP_SIGNING_KEYS`);
  }

  const connectTokenTtlS = int(env, 'CONNECT_TOKEN_TTL_S', 60);
  if (connectTokenTtlS < 1 || connectTokenTtlS > 60) {
    throw new ConfigError('CONNECT_TOKEN_TTL_S must be between 1 and 60 (broker enforces a 60s ceiling)');
  }

  const cloud = (env['CLOUD_PROVIDER'] ?? 'fake') as CloudKind;
  if (cloud !== 'fake' && cloud !== 'aws') {
    throw new ConfigError(`CLOUD_PROVIDER must be 'fake' or 'aws', got ${JSON.stringify(cloud)}`);
  }

  // Development fallbacks are explicit opt-in and OFF by default. Refuse to
  // enable them in production so a mis-set environment can never serve a
  // fabricated session/teardown (audit finding C1/H6).
  const envName = env['DFAP_ENV'] ?? 'phase0';
  const isProduction = isProductionEnv(env);
  const devFallback = bool(env, 'DFAP_DEV_FALLBACK', false);
  if (devFallback && isProduction) {
    throw new ConfigError('DFAP_DEV_FALLBACK must not be enabled in production');
  }

  // Durable key material (Layer 2) and the pair-key master (spec TA-4). Both
  // are validated now so a misconfiguration fails boot, not the first request.
  const credentialKey = parseCredentialKey(env);
  const pairMasterKey = parsePairMasterKey(env);

  // Inbound auth defaults to fail-closed ('deny'): without a real IdP the
  // control plane must reject requests, not trust client-asserted identity.
  const authMode = parseAuthMode(env, envName);
  const corsAllowedOrigins = parseCorsAllowedOrigins(env);
  const guestProvisioning = parseGuestProvisioning(env, isProduction);

  const cfg: ApiConfig = {
    env: envName,
    port: int(env, 'API_PORT', 8081),
    databaseUrl: req(env, 'DATABASE_URL'),
    signingKeys,
    signingKid,
    brokerUrl: req(env, 'BROKER_URL'),
    connectTokenTtlS,
    credentialTtlS: boundedInt(env, 'CREDENTIAL_TTL_S', 900, 60, 86_400),
    // A browser refresh / laptop sleep / Wi-Fi flap must not destroy a VM. The
    // window is bounded in both directions: too short punishes a normal
    // reconnect, too long holds paid capacity for an abandoned tab.
    sessionDisconnectGraceS: boundedInt(env, 'DFAP_SESSION_DISCONNECT_GRACE_S', 30, 5, 600),
    sessionReaperIntervalS: boundedInt(env, 'DFAP_SESSION_REAPER_INTERVAL_S', 15, 5, 300),
    cloud,
    devFallback,
    authMode,
    corsAllowedOrigins,
    guestProvisioning: guestProvisioning.mode,
    guestProvisioningTtlS: boundedInt(env, 'DFAP_GUEST_PROVISIONING_TTL_S', 900, 60, 3600),
    guestProvisioningMaxDeliveries: boundedInt(env, 'DFAP_GUEST_PROVISIONING_MAX_DELIVERIES', 10, 1, 100),
    readyTimeoutS: boundedInt(env, 'DFAP_READY_TIMEOUT_S', 600, 30, 3_600),
    readyProbePort: boundedInt(env, 'DFAP_READY_PROBE_PORT', 3389, 1, 65_535),
  };

  const evalSshPublicKey = env['DFAP_EVAL_SSH_PUBKEY'];
  if (evalSshPublicKey) cfg.evalSshPublicKey = evalSshPublicKey;

  if (guestProvisioning.certs) cfg.guestIdentityCerts = guestProvisioning.certs;
  if (credentialKey) cfg.credentialKey = credentialKey;
  if (pairMasterKey) cfg.pairMasterKey = pairMasterKey;

  // OIDC verification settings are required exactly when the adapter is
  // selected; missing config fails boot rather than weakening trust.
  if (authMode === 'oidc') {
    cfg.oidc = parseOidc(env);
  }

  if (cloud === 'aws') {
    const sessionAmiId = req(env, 'AWS_SESSION_AMI_ID');
    if (!/^ami-[0-9a-f]{8,}$/.test(sessionAmiId) || sessionAmiId === 'ami-phase0-placeholder') {
      throw new ConfigError('AWS_SESSION_AMI_ID must be a real ami-* identifier, not a placeholder');
    }
    const sessionInstanceType = req(env, 'AWS_SESSION_INSTANCE_TYPE');
    const sessionArchitecture = req(env, 'AWS_SESSION_ARCHITECTURE');
    if (sessionArchitecture !== 'x86_64' && sessionArchitecture !== 'arm64') {
      throw new ConfigError("AWS_SESSION_ARCHITECTURE must be 'x86_64' or 'arm64'");
    }
    const armFamilies = /^(a1|t4g|c7g|m7g|r7g|x2gd|g5g)\./;
    const instanceIsArm = armFamilies.test(sessionInstanceType);
    if (instanceIsArm !== (sessionArchitecture === 'arm64')) {
      throw new ConfigError(
        `AWS_SESSION_INSTANCE_TYPE ${sessionInstanceType} is incompatible with AWS_SESSION_ARCHITECTURE ${sessionArchitecture}`,
      );
    }
    // The root volume is sent on RunInstances (see buildRunInstancesInput), so
    // the size is validated here rather than trusted from the launch template.
    const sessionVolumeGiB = Number(env['AWS_SESSION_VOLUME_GIB'] ?? '20');
    if (!Number.isInteger(sessionVolumeGiB) || sessionVolumeGiB < 8 || sessionVolumeGiB > 100) {
      throw new ConfigError('AWS_SESSION_VOLUME_GIB must be an integer between 8 and 100');
    }
    cfg.aws = {
      region: req(env, 'AWS_REGION'),
      launchTemplateId: req(env, 'AWS_LAUNCH_TEMPLATE_ID'),
      ...(env['AWS_LAUNCH_TEMPLATE_VERSION'] ? { launchTemplateVersion: env['AWS_LAUNCH_TEMPLATE_VERSION'] } : {}),
      sessionAmiId,
      sessionInstanceType,
      sessionArchitecture,
      sessionVolumeGiB,
    };
  }

  const vault = parseVault(env, isProduction);
  if (vault) cfg.vault = vault;

  if (env['STRIPE_API_KEY']) {
    cfg.stripe = { apiKey: env['STRIPE_API_KEY'], webhookSecret: req(env, 'STRIPE_WEBHOOK_SECRET') };
  }

  // Production must select explicitly supported, durable providers. Each guard
  // refuses a silent fallback that would otherwise masquerade as real security:
  // an ephemeral credential key, a non-secret pair seed, or an in-memory Vault.
  if (isProduction) {
    if (!cfg.credentialKey || (!cfg.credentialKey.file && !cfg.credentialKey.pem)) {
      throw new ConfigError(
        'production requires a durable credential key: set DFAP_CREDENTIAL_KEY_FILE or DFAP_CREDENTIAL_KEY_PEM (refusing an ephemeral key)',
      );
    }
    if (!cfg.pairMasterKey) {
      throw new ConfigError(
        'production requires DFAP_PAIR_MASTER_KEY (refusing the non-secret dev-derived pair seed)',
      );
    }
    if (!cfg.vault) {
      throw new ConfigError(
        'production requires VAULT_ADDR plus a scoped Vault identity (VAULT_APPROLE_ROLE_ID/SECRET_ID preferred, or VAULT_TOKEN) — refusing the in-memory FakeVaultClient',
      );
    }
  }

  return cfg;
}
