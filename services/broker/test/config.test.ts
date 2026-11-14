import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { keyringFromConfig, loadConfig } from '../src/config.js';

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DFAP_SIGNING_KEYS: `k1:${randomBytes(32).toString('base64')}`,
    DFAP_SIGNING_KID: 'k1',
    ...overrides,
  };
}

describe('broker config', () => {
  it('applies development defaults without requiring guacd TLS', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.port).toBe(8080);
    expect(cfg.path).toBe('/tunnel');
    expect(cfg.guacd).toEqual({ host: '127.0.0.1', port: 4822, tls: false });
    expect(cfg.maxClientViolations).toBe(5);
    expect(cfg.redisUrl).toBeUndefined();
  });

  it('reads values from the provided env, not the ambient process.env', () => {
    const cfg = loadConfig(baseEnv({ BROKER_PORT: '9099', GUACD_PORT: '5833', MAX_CLIENT_VIOLATIONS: '2' }));
    expect(cfg.port).toBe(9099);
    expect(cfg.guacd.port).toBe(5833);
    expect(cfg.maxClientViolations).toBe(2);
  });

  it('refuses cleartext guacd in production', () => {
    expect(() => loadConfig(baseEnv({ DFAP_ENV: 'production' }))).toThrow(/GUACD_TLS must be true in production/);
  });

  it('treats NODE_ENV=production the same as DFAP_ENV=production', () => {
    expect(() => loadConfig(baseEnv({ NODE_ENV: 'production' }))).toThrow(/GUACD_TLS must be true in production/);
  });

  it('allows cleartext only with an explicit acknowledgement', () => {
    const cfg = loadConfig(baseEnv({ DFAP_ENV: 'production', GUACD_ALLOW_CLEARTEXT: 'true' }));
    expect(cfg.guacd.tls).toBe(false);
  });

  it('requires a pinned CA so the guacd peer is authenticated', () => {
    expect(() =>
      loadConfig(baseEnv({ DFAP_ENV: 'production', GUACD_TLS: 'true', GUACD_CERT: '/c.pem', GUACD_KEY: '/k.pem' })),
    ).toThrow(/GUACD_CA must be set in production/);
  });

  it('accepts a fully pinned production guacd channel', () => {
    const cfg = loadConfig(
      baseEnv({
        DFAP_ENV: 'production',
        GUACD_TLS: 'true',
        GUACD_CA: '/ca.pem',
        GUACD_CERT: '/c.pem',
        GUACD_KEY: '/k.pem',
      }),
    );
    expect(cfg.guacd).toEqual({
      host: '127.0.0.1',
      port: 4822,
      tls: true,
      caPath: '/ca.pem',
      certPath: '/c.pem',
      keyPath: '/k.pem',
    });
  });

  it('requires the client cert and key whenever TLS is on', () => {
    expect(() => loadConfig(baseEnv({ GUACD_TLS: 'true', GUACD_CA: '/ca.pem' }))).toThrow(/GUACD_CERT/);
  });

  it('rejects a non-integer port', () => {
    expect(() => loadConfig(baseEnv({ BROKER_PORT: 'eighty' }))).toThrow(/BROKER_PORT must be an integer/);
  });

  it('rejects an active kid that is not in the key set', () => {
    expect(() => loadConfig(baseEnv({ DFAP_SIGNING_KID: 'k9' }))).toThrow(/not present in DFAP_SIGNING_KEYS/);
  });

  it('rejects a signing key shorter than 32 bytes', () => {
    const cfg = loadConfig({ DFAP_SIGNING_KEYS: 'k1:c2hvcnQ=', DFAP_SIGNING_KID: 'k1' });
    expect(() => keyringFromConfig(cfg)).toThrow(/shorter than 32 bytes/);
  });
});
