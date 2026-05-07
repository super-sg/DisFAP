/**
 * ============================================================================
 * Unit Tests — Provisioner
 * ============================================================================
 */

const { generatePassword, buildUserData } = require('../src/provisioner');

describe('Provisioner', () => {
  describe('generatePassword', () => {
    test('generates a password of the specified length', () => {
      const password = generatePassword(24);
      expect(password).toHaveLength(24);
    });

    test('generates a password with default length of 24', () => {
      const password = generatePassword();
      expect(password).toHaveLength(24);
    });

    test('generates unique passwords each time', () => {
      const passwords = new Set();
      for (let i = 0; i < 100; i++) {
        passwords.add(generatePassword());
      }
      // All 100 passwords should be unique
      expect(passwords.size).toBe(100);
    });

    test('generates passwords with valid characters', () => {
      const validChars = /^[a-zA-Z0-9!@#$%^&*]+$/;
      const password = generatePassword(100);
      expect(password).toMatch(validChars);
    });

    test('generates password of custom length', () => {
      expect(generatePassword(8)).toHaveLength(8);
      expect(generatePassword(32)).toHaveLength(32);
      expect(generatePassword(64)).toHaveLength(64);
    });
  });

  describe('buildUserData', () => {
    test('builds Windows user data script', () => {
      const userData = buildUserData('windows', 'session-user', 'test-pass', 'sess-123', 'user-456');
      const decoded = Buffer.from(userData, 'base64').toString('utf-8');

      expect(decoded).toContain('<powershell>');
      expect(decoded).toContain('session-user');
      expect(decoded).toContain('test-pass');
      expect(decoded).toContain('SESSION_READY');
      expect(decoded).toContain('Disable-LocalUser');
    });

    test('builds Linux user data script', () => {
      const userData = buildUserData('linux', 'session-user', 'test-pass', 'sess-123', 'user-456');
      const decoded = Buffer.from(userData, 'base64').toString('utf-8');

      expect(decoded).toContain('#!/bin/bash');
      expect(decoded).toContain('chpasswd');
      expect(decoded).toContain('vncpasswd');
      expect(decoded).toContain('SESSION_READY');
      expect(decoded).toContain('session-manager');
    });

    test('user data is base64 encoded', () => {
      const userData = buildUserData('windows', 'user', 'pass', 'id', 'uid');
      // Should be valid base64
      expect(() => Buffer.from(userData, 'base64')).not.toThrow();
      // Should decode to a non-empty string
      expect(Buffer.from(userData, 'base64').toString('utf-8').length).toBeGreaterThan(0);
    });

    test('includes session ID in Linux script for logging', () => {
      const userData = buildUserData('linux', 'user', 'pass', 'my-session', 'my-user');
      const decoded = Buffer.from(userData, 'base64').toString('utf-8');
      expect(decoded).toContain('my-session');
      expect(decoded).toContain('my-user');
    });
  });
});
