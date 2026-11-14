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

function cloudInitUserData(result: Awaited<ReturnType<CloudInitInjector['prepare']>>): string {
  if (result.method !== 'cloud-init' || typeof result.userData !== 'string') {
    throw new Error('Expected cloud-init user data');
  }
  return result.userData;
}

describe('CloudInitInjector', () => {
  it('renders a cloud-config that creates the account and brings up XFCE over xrdp', async () => {
    const injector = new CloudInitInjector();
    const result = await injector.prepare(spec, { username: 'dfapdemo', password: 'Dfap-abc123', demoOnly: true });
    expect(result.method).toBe('cloud-init');
    const ud = cloudInitUserData(result);
    expect(ud.startsWith('#cloud-config')).toBe(true);
    expect(ud).toContain('name: dfapdemo');
    expect(ud).toContain('password: Dfap-abc123');
    expect(ud).toContain('xrdp');
    expect(ud).toContain('xfce4');
    expect(ud).toContain('startxfce4');
  });

  it('normalises the username to lower case', async () => {
    const injector = new CloudInitInjector();
    const result = await injector.prepare(spec, { username: 'DemoUser', password: 'Dfap-abc123', demoOnly: true });
    expect(cloudInitUserData(result)).toContain('name: demouser');
  });

  it('refuses an invalid POSIX username', async () => {
    const injector = new CloudInitInjector();
    await expect(injector.prepare(spec, { username: 'Bad Name', password: 'Dfap-abc123', demoOnly: true })).rejects.toThrow(
      /username/,
    );
  });

  it('refuses a short password', async () => {
    const injector = new CloudInitInjector();
    await expect(injector.prepare(spec, { username: 'dfapdemo', password: 'short', demoOnly: true })).rejects.toThrow(
      /at least 8/,
    );
  });

  it('refuses a password that would corrupt the chpasswd list', async () => {
    const injector = new CloudInitInjector();
    await expect(
      injector.prepare(spec, { username: 'dfapdemo', password: 'has:colon', demoOnly: true }),
    ).rejects.toThrow(/colon or newline/);
  });

  it('refuses reusable credentials for user data', async () => {
    const injector = new CloudInitInjector();
    await expect(injector.prepare(spec, { username: 'licensed-user', password: 'reusable-pass' })).rejects.toThrow(
      /reusable licensed credentials/,
    );
  });

  it('refuses to be constructed for production (evaluation-only)', () => {
    expect(() => new CloudInitInjector({ production: true })).toThrow(/evaluation-only/);
  });

  it('adds a validated key-only SSH path when a public key is supplied', async () => {
    const pub = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOdc04YsZLux7JrgikPAbLAcGHziUaQjY2GhbDc95I0T dfap-demo-eval';
    const injector = new CloudInitInjector({ sshPublicKey: pub });
    const result = await injector.prepare(spec, { username: 'dfapdemo', password: 'Dfap-abc123', demoOnly: true });
    const userData = cloudInitUserData(result);
    expect(userData).toContain('    ssh_authorized_keys:');
    expect(userData).toContain(`      - ${pub}`);
    // The key must be nested under the demo user, not a top-level cloud-config
    // key (cloud-init silently ignores that, breaking first-boot diagnostics).
    expect(userData).not.toMatch(/^ssh_authorized_keys:/m);
    // It must be inside the user entry, before the next top-level key.
    expect(userData.indexOf('    ssh_authorized_keys:')).toBeGreaterThan(
      userData.indexOf('  - name: dfapdemo'),
    );
    expect(userData.indexOf('    ssh_authorized_keys:')).toBeLessThan(userData.indexOf('\nssh_pwauth:'));
    // The temporary operator SSH path needs sudo to read first-boot diagnostics.
    expect(userData).toContain('    sudo: ALL=(ALL) NOPASSWD:ALL');
    // The stock user must survive so the demo account does not replace it.
    expect(userData).toContain('- default');
  });

  it('refuses a public key that is not a single-line OpenSSH key', () => {
    expect(() => new CloudInitInjector({ sshPublicKey: 'not a key' })).toThrow(/OpenSSH public key/);
    expect(() => new CloudInitInjector({ sshPublicKey: 'ssh-ed25519 AAAA\ninjected: true' })).toThrow(
      /OpenSSH public key/,
    );
  });

  it('omits the SSH block entirely when no key is configured', async () => {
    const injector = new CloudInitInjector();
    const result = await injector.prepare(spec, { username: 'dfapdemo', password: 'Dfap-abc123', demoOnly: true });
    const userData = cloudInitUserData(result);
    expect(userData).not.toContain('ssh_authorized_keys');
    expect(userData).not.toContain('NOPASSWD');
  });
});

describe('renderCloudInit', () => {
  it('escapes nothing untrusted — it only emits a validated username/password', () => {
    const ud = renderCloudInit('dfapdemo', 'Dfap-abc123');
    expect(ud).toContain('chpasswd:');
    expect(ud).toContain('type: text');
  });

  it('installs and auto-starts the purpose-built DisFAP demo application', () => {
    const ud = renderCloudInit('dfapdemo', 'Dfap-abc123');
    // The demo app itself, its GUI runtime, and its session autostart entry.
    expect(ud).toContain('/usr/local/bin/dfap-demo-app.py');
    // The installer is invoked as an explicit `bash` call (cloud-init prefixes
    // its runcmd script with #!/bin/sh, so an inline script would run under dash).
    expect(ud).toContain('/usr/local/bin/dfap-install-desktop.sh');
    expect(ud).toContain('bash, /usr/local/bin/dfap-install-desktop.sh, dfapdemo');
    // Per-user files are created by the installer (write_files cannot own files
    // for an account that does not exist yet).
    expect(ud).toContain('/home/$USERNAME/.config/autostart/dfap-demo.desktop');
    expect(ud).toContain('DisFAP Demo Application');
    expect(ud).toContain('python3-tk');
    expect(ud).toContain('policy-rc.d');
    expect(ud).toContain('chown -R "$USERNAME:$USERNAME" "/home/$USERNAME/.config"');
    expect(ud).toContain('win.mainloop()');
    // It must be a demo, never a claim to be the owner's software.
    expect(ud).toContain("not the owner's software");
  });
});
