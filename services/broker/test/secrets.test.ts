import { describe, expect, it } from 'vitest';
import { scrubCredential, scrubGuacParams } from '../src/secrets.js';

describe('credential scrubbing', () => {
  it('overwrites every string field in place', () => {
    const cred = { username: 'u', password: 'p', privateKey: 'k' };
    scrubCredential(cred);
    expect(cred).toEqual({ username: '', password: '', privateKey: '' });
  });

  it('does not invent optional fields that were absent', () => {
    const cred: { username: string; password?: string } = { username: 'u' };
    scrubCredential(cred);
    expect(cred).toEqual({ username: '' });
    expect('password' in cred).toBe(false);
  });

  it('clears every secret-bearing guacd parameter', () => {
    const params = {
      hostname: '10.0.1.5',
      username: 'u',
      password: 'p',
      'private-key': 'k',
      passphrase: 'pp',
      domain: 'ACME',
      'disable-copy': 'true',
    };
    scrubGuacParams(params);
    expect(params).toEqual({
      hostname: '10.0.1.5',
      username: '',
      password: '',
      'private-key': '',
      passphrase: '',
      domain: '',
      'disable-copy': 'true',
    });
  });

  it('leaves a parameter map with no secrets untouched', () => {
    const params = { hostname: 'h', port: '3389', 'ignore-cert': 'true' };
    scrubGuacParams(params);
    expect(params).toEqual({ hostname: 'h', port: '3389', 'ignore-cert': 'true' });
  });
});
