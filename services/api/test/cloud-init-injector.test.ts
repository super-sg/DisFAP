import { describe, it, expect } from 'vitest';

import { CloudInitInjector, renderCloudInit } from '../src/cloud/cloud-init-injector.js';
import type { LaunchSpec } from '../src/cloud/provider.js';

const spec: LaunchSpec = {
  templateId: 'tmpl_linux_dev',
  region: 'us-east-1',
  imageId: 'ami-123',
  instanceType: 't3.large',
  sessionId: 'ses_1',
  orgId: 'org_1',
  expiresAt: new Date('2026-10-16T01:00:00Z'),
};

describe('CloudInitInjector', () => {
  it('renders a cloud-config that creates the account and brings up XFCE over xrdp', async () => {
    const injector = new CloudInitInjector();
    const result = await injector.prepare(spec, { username: 'dfapdemo', password: 'Dfap-abc123' });
    expect(result.method).toBe('cloud-init');
    expect(result.userData).toBeTypeOf('string');
    const ud = result.userData!;
    expect(ud.startsWith('#cloud-config')).toBe(true);
    expect(ud).toContain('name: dfapdemo');
    expect(ud).toContain('password: Dfap-abc123');
    expect(ud).toContain('xrdp');
    expect(ud).toContain('xfce4');
    expect(ud).toContain('startxfce4');
  });

  it('normalises the username to lower case', async () => {
    const injector = new CloudInitInjector();
    const result = await injector.prepare(spec, { username: 'DemoUser', password: 'Dfap-abc123' });
    expect(result.userData).toContain('name: demouser');
  });

  it('refuses an invalid POSIX username', async () => {
    const injector = new CloudInitInjector();
    await expect(injector.prepare(spec, { username: 'Bad Name', password: 'Dfap-abc123' })).rejects.toThrow(
      /username/,
    );
  });

  it('refuses a short password', async () => {
    const injector = new CloudInitInjector();
    await expect(injector.prepare(spec, { username: 'dfapdemo', password: 'short' })).rejects.toThrow(
      /at least 8/,
    );
  });

  it('refuses a password that would corrupt the chpasswd list', async () => {
    const injector = new CloudInitInjector();
    await expect(
      injector.prepare(spec, { username: 'dfapdemo', password: 'has:colon' }),
    ).rejects.toThrow(/colon or newline/);
  });

  it('refuses to be constructed for production (evaluation-only)', () => {
    expect(() => new CloudInitInjector({ production: true })).toThrow(/evaluation-only/);
  });
});

describe('renderCloudInit', () => {
  it('escapes nothing untrusted — it only emits a validated username/password', () => {
    const ud = renderCloudInit('dfapdemo', 'Dfap-abc123');
    expect(ud).toContain('chpasswd:');
    expect(ud).toContain('type: text');
  });
});
