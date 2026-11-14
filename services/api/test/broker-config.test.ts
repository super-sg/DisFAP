import { describe, expect, it } from 'vitest';

import { buildBrokerConfig } from '../src/server.js';
import { keyringFromConfig } from '@disfap/broker/src/config.js';

/**
 * The in-process broker used to be configured by a second, hand-rolled parser in
 * `server.ts` that skipped every broker guard (short keys, cleartext guacd in
 * production, missing CA). These tests pin the delegation to the broker's own
 * `loadConfig`, which is the single enforcement point.
 */
const base = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  DFAP_SIGNING_KEYS: `k1:${Buffer.alloc(32, 1).toString('base64')}`,
  DFAP_SIGNING_KID: 'k1',
  BROKER_PORT: '8080',
  BROKER_WS_PATH: '/tunnel',
  ...extra,
});

describe('buildBrokerConfig — delegates to the broker validator', () => {
  it('parses the normal development wiring', () => {
    const cfg = buildBrokerConfig(base({ GUACD_HOST: '127.0.0.1', GUACD_PORT: '4822', REDIS_URL: 'redis://r:6379' }));
    expect(cfg).toMatchObject({
      port: 8080,
      path: '/tunnel',
      guacd: { host: '127.0.0.1', port: 4822, tls: false },
      redisUrl: 'redis://r:6379',
    });
  });

  it('refuses cleartext guacd in production unless explicitly acknowledged', () => {
    expect(() => buildBrokerConfig(base({ NODE_ENV: 'production' }))).toThrow(/GUACD_TLS must be true/);
    const cfg = buildBrokerConfig(base({ NODE_ENV: 'production', GUACD_ALLOW_CLEARTEXT: 'true' }));
    expect(cfg.guacd.tls).toBe(false);
  });

  it('refuses TLS without a pinned CA in production', () => {
    expect(() =>
      buildBrokerConfig(
        base({
          NODE_ENV: 'production',
          GUACD_TLS: 'true',
          GUACD_CERT: '/run/secrets/guacd-client.pem',
          GUACD_KEY: '/run/secrets/guacd-client-key.pem',
        }),
      ),
    ).toThrow(/GUACD_CA/);
  });

  it('requires a signing kid that exists in the keyring', () => {
    expect(() => buildBrokerConfig(base({ DFAP_SIGNING_KID: 'nope' }))).toThrow(/not present/);
  });

  it('still rejects a short signing key at keyring construction', () => {
    const cfg = buildBrokerConfig(base({ DFAP_SIGNING_KEYS: `k1:${Buffer.alloc(16, 1).toString('base64')}` }));
    expect(() => keyringFromConfig(cfg)).toThrow(/shorter than 32 bytes/);
  });

  it('rejects a malformed port', () => {
    expect(() => buildBrokerConfig(base({ BROKER_PORT: 'eighty' }))).toThrow(/BROKER_PORT/);
  });
});
