/**
 * Broker configuration, loaded and validated from the environment once at
 * startup. Fails fast with a clear message on anything missing or malformed —
 * a misconfigured broker must never start and silently accept connections.
 */

import { readFileSync } from 'node:fs';

export interface BrokerConfig {
  port: number;
  path: string;
  guacd: { host: string; port: number; tls: boolean; caPath?: string; certPath?: string; keyPath?: string };
  /** Base64-encoded HMAC signing keys by kid, plus which kid is active. */
  signingKeys: Record<string, string>;
  signingKid: string;
  redisUrl?: string;
  maxClientViolations: number;
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

export function loadConfig(env = process.env): BrokerConfig {
  // Signing keys arrive as DFAP_SIGNING_KEYS='kid1:base64,kid2:base64'.
  const rawKeys = env['DFAP_SIGNING_KEYS'];
  if (!rawKeys) throw new ConfigError('missing required env DFAP_SIGNING_KEYS');
  const signingKeys: Record<string, string> = {};
  for (const pair of rawKeys.split(',')) {
    const [kid, b64] = pair.split(':');
    if (!kid || !b64) throw new ConfigError(`malformed DFAP_SIGNING_KEYS entry ${JSON.stringify(pair)}`);
    signingKeys[kid.trim()] = b64.trim();
  }
  const signingKid = req(env, 'DFAP_SIGNING_KID');
  if (!signingKeys[signingKid]) throw new ConfigError(`DFAP_SIGNING_KID ${signingKid} not present in DFAP_SIGNING_KEYS`);

  // The session credential is injected into guacd over this channel, so in
  // production it must be encrypted and the gateway authenticated. The spec
  // calls for a mutually verified channel; guacd verifies nothing but its own
  // certificate, so the enforceable half is: TLS on, peer pinned to an
  // operator-supplied CA. A cleartext socket is acceptable only when guacd is
  // reached over a private, unpublished network — and that must be an explicit,
  // named acknowledgement, never a silent default.
  const isProduction = env['DFAP_ENV'] === 'production' || env['NODE_ENV'] === 'production';
  const tls = env['GUACD_TLS'] === 'true';
  const allowCleartext = env['GUACD_ALLOW_CLEARTEXT'] === 'true';
  if (isProduction && !tls && !allowCleartext) {
    throw new ConfigError(
      'GUACD_TLS must be true in production: the session credential is injected into guacd over this channel. ' +
        'Set GUACD_ALLOW_CLEARTEXT=true only if guacd has no published port and is reachable solely over a private bridge.',
    );
  }
  if (isProduction && tls && !env['GUACD_CA']) {
    throw new ConfigError(
      'GUACD_CA must be set in production so guacd is authenticated against a pinned CA, not the ambient trust store',
    );
  }

  return {
    port: int(env, 'BROKER_PORT', 8080),
    path: env['BROKER_WS_PATH'] ?? '/tunnel',
    guacd: {
      host: env['GUACD_HOST'] ?? '127.0.0.1',
      port: int(env, 'GUACD_PORT', 4822),
      tls,
      ...(tls
        ? {
            certPath: req(env, 'GUACD_CERT'),
            keyPath: req(env, 'GUACD_KEY'),
            ...(env['GUACD_CA'] ? { caPath: env['GUACD_CA'] } : {}),
          }
        : {}),
    },
    signingKeys,
    signingKid,
    ...(env['REDIS_URL'] ? { redisUrl: env['REDIS_URL'] } : {}),
    maxClientViolations: int(env, 'MAX_CLIENT_VIOLATIONS', 5),
  };
}

export function keyringFromConfig(cfg: BrokerConfig): { keys: Map<string, Buffer>; signingKid: string } {
  const keys = new Map<string, Buffer>();
  for (const [kid, b64] of Object.entries(cfg.signingKeys)) {
    const key = Buffer.from(b64, 'base64');
    if (key.length < 32) throw new ConfigError(`signing key ${kid} is shorter than 32 bytes`);
    keys.set(kid, key);
  }
  return { keys, signingKid: cfg.signingKid };
}

export function readGuacdTls(cfg: BrokerConfig): false | { ca?: string; cert: string; key: string } {
  if (!cfg.guacd.tls) return false;
  return {
    ...(cfg.guacd.caPath ? { ca: readFileSync(cfg.guacd.caPath, 'utf8') } : {}),
    cert: readFileSync(cfg.guacd.certPath!, 'utf8'),
    key: readFileSync(cfg.guacd.keyPath!, 'utf8'),
  };
}
