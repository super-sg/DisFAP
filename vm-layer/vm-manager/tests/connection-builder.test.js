/**
 * ============================================================================
 * Unit Tests — Connection Builder (Guacamole)
 * ============================================================================
 */

// Set env vars before requiring config
process.env.GUACAMOLE_SECRET_KEY = 'test-secret-key-for-hmac-sha256';
process.env.GUACAMOLE_URL = 'http://localhost:8080/guacamole';
process.env.NODE_ENV = 'test';

const {
  buildTokenPayload,
  signToken,
  buildRdpParameters,
  buildVncParameters,
} = require('../src/connection-builder');

describe('Connection Builder', () => {
  describe('buildTokenPayload', () => {
    test('builds a valid RDP token payload', () => {
      const payload = buildTokenPayload({
        sessionId: 'sess-abc123',
        hostname: '10.0.2.50',
        port: '3389',
        protocol: 'rdp',
        username: 'session-user',
        password: 'test-password',
        ttlMinutes: 60,
      });

      expect(payload.username).toBe('session-sess-abc123');
      expect(payload.expires).toBeDefined();
      expect(parseInt(payload.expires, 10)).toBeGreaterThan(Date.now());
      expect(payload.connections).toBeDefined();
      expect(payload.connections['Session-sess-abc123']).toBeDefined();
      expect(payload.connections['Session-sess-abc123'].protocol).toBe('rdp');
    });

    test('builds a valid VNC token payload', () => {
      const payload = buildTokenPayload({
        sessionId: 'sess-def456',
        hostname: '10.0.2.100',
        port: '5901',
        protocol: 'vnc',
        username: 'session-user',
        password: 'test-password',
      });

      expect(payload.connections['Session-sess-def456'].protocol).toBe('vnc');
    });

    test('sets expiry based on TTL minutes', () => {
      const now = Date.now();
      const payload = buildTokenPayload({
        sessionId: 'sess-ttl',
        hostname: '10.0.2.50',
        port: '3389',
        protocol: 'rdp',
        username: 'user',
        password: 'pass',
        ttlMinutes: 120,
      });

      const expires = parseInt(payload.expires, 10);
      // Should be approximately 120 minutes from now (with 5 second tolerance)
      expect(expires).toBeGreaterThanOrEqual(now + 119 * 60 * 1000);
      expect(expires).toBeLessThanOrEqual(now + 121 * 60 * 1000);
    });
  });

  describe('buildRdpParameters', () => {
    test('includes all required RDP parameters', () => {
      const params = buildRdpParameters('10.0.2.50', '3389', 'user', 'pass');

      expect(params.hostname).toBe('10.0.2.50');
      expect(params.port).toBe('3389');
      expect(params.username).toBe('user');
      expect(params.password).toBe('pass');
      expect(params.security).toBe('rdp');
      expect(params['ignore-cert']).toBe('true');
    });

    test('disables clipboard for security', () => {
      const params = buildRdpParameters('10.0.2.50', '3389', 'user', 'pass');
      expect(params['disable-clipboard']).toBe('true');
    });

    test('disables drive and printing for security', () => {
      const params = buildRdpParameters('10.0.2.50', '3389', 'user', 'pass');
      expect(params['enable-drive']).toBe('false');
      expect(params['enable-printing']).toBe('false');
    });

    test('enables font smoothing for quality', () => {
      const params = buildRdpParameters('10.0.2.50', '3389', 'user', 'pass');
      expect(params['enable-font-smoothing']).toBe('true');
    });
  });

  describe('buildVncParameters', () => {
    test('includes all required VNC parameters', () => {
      const params = buildVncParameters('10.0.2.100', '5901', 'pass');

      expect(params.hostname).toBe('10.0.2.100');
      expect(params.port).toBe('5901');
      expect(params.password).toBe('pass');
    });

    test('disables clipboard for security', () => {
      const params = buildVncParameters('10.0.2.100', '5901', 'pass');
      expect(params['disable-clipboard']).toBe('true');
    });
  });

  describe('signToken', () => {
    test('produces a non-empty signed token', () => {
      const payload = {
        username: 'test-user',
        expires: (Date.now() + 3600000).toString(),
        connections: {},
      };

      const token = signToken(payload);
      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    });

    test('produces different tokens for different payloads', () => {
      const payload1 = { username: 'user1', expires: '1', connections: {} };
      const payload2 = { username: 'user2', expires: '2', connections: {} };

      const token1 = signToken(payload1);
      const token2 = signToken(payload2);

      expect(token1).not.toBe(token2);
    });

    test('produces the same token for the same payload', () => {
      const payload = { username: 'user', expires: '12345', connections: {} };

      const token1 = signToken(payload);
      const token2 = signToken(payload);

      expect(token1).toBe(token2);
    });

    test('produces a valid base64 string', () => {
      const payload = { username: 'user', expires: '12345', connections: {} };
      const token = signToken(payload);

      // Should not throw when decoding
      expect(() => Buffer.from(token, 'base64')).not.toThrow();
    });
  });
});
