import { describe, expect, it } from 'vitest';

import {
  NoPreBootInjector,
  OfflineImageInjector,
  PREBOOT_MARKER,
  deriveImageWrapKey,
} from '../src/cloud/disk-injector.js';
import type { LaunchSpec } from '../src/cloud/provider.js';

const IMAGE_KEY = deriveImageWrapKey(Buffer.alloc(32, 3));

function spec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    templateId: 'tmpl_win_rdp',
    region: 'us-east-1',
    imageId: 'ami-hardened-phase0',
    instanceType: 't4g.small',
    sessionId: 'ses_preboot_1',
    orgId: 'org_1',
    expiresAt: new Date('2026-07-22T18:00:00Z'),
    ...overrides,
  };
}

describe('OfflineImageInjector — credentials on disk before boot (spec step 5)', () => {
  it('seals the credential into a userData blob that carries no plaintext', async () => {
    const injector = new OfflineImageInjector(IMAGE_KEY);
    const { method, userData } = await injector.prepare(spec(), {
      username: 'dfap-admin',
      password: 'SuperSecret_2026!',
    });

    expect(method).toBe('sealed-blob');
    expect(userData).toBeDefined();
    expect(userData!.startsWith(PREBOOT_MARKER)).toBe(true);
    // The whole point: plaintext never appears on the disk artifact.
    expect(userData).not.toContain('SuperSecret_2026!');
    expect(userData).not.toContain('dfap-admin');
    expect(injector.injectedSessions()).toContain('ses_preboot_1');
  });

  it('unseals to exactly the credential it was given, bound to the image', async () => {
    const injector = new OfflineImageInjector(IMAGE_KEY);
    const { userData } = await injector.prepare(spec(), { username: 'matlab_user', password: 'p@ss' });

    const opened = OfflineImageInjector.unseal(IMAGE_KEY, 'ami-hardened-phase0', userData!);
    expect(opened.username).toBe('matlab_user');
    expect(opened.password).toBe('p@ss');
    expect(opened.sessionId).toBe('ses_preboot_1');
  });

  it('fails to unseal for a different image or a different key', async () => {
    const injector = new OfflineImageInjector(IMAGE_KEY);
    const { userData } = await injector.prepare(spec(), { username: 'u', password: 'p' });

    // A blob leaked to a different AMI is useless (AAD binds the image id).
    expect(() => OfflineImageInjector.unseal(IMAGE_KEY, 'ami-some-other', userData!)).toThrow();
    // A different guest-image key can't open it either.
    expect(() => OfflineImageInjector.unseal(deriveImageWrapKey(Buffer.alloc(32, 9)), 'ami-hardened-phase0', userData!)).toThrow();
  });

  it('skips injection when there is no session id yet', async () => {
    const injector = new OfflineImageInjector(IMAGE_KEY);
    const { sessionId: _omitted, ...noSession } = spec();
    const result = await injector.prepare(noSession, { username: 'u' });
    expect(result.method).toBe('none');
    expect(result.userData).toBeUndefined();
  });

  it('rejects a too-short image wrap key', () => {
    expect(() => new OfflineImageInjector(Buffer.alloc(16, 1))).toThrow(/wrap key/);
  });

  it('the explicit no-op injector writes nothing', async () => {
    const result = await new NoPreBootInjector().prepare(spec(), { username: 'u' });
    expect(result).toEqual({ method: 'none' });
  });
});
