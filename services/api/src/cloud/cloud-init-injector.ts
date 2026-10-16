/**
 * CloudInitInjector — the LOCAL-EVALUATION guest bootstrap (NOT production).
 *
 * The production guest-credential path is the verified-instance-identity pull
 * (audit C3 / M8, `guest/guest-provisioning.ts`): the golden image already has
 * the desktop + a `dfap-provision.service` unit, and the credential is fetched
 * once, over TLS, after the guest proves its identity — never placed in
 * userData. This injector is the *evaluation-only* stand-in used when we boot a
 * stock Ubuntu AMI with no golden image: there is no in-guest provisioning
 * unit, so we hand cloud-init a small script that (a) creates the licensed
 * demo account and (b) installs and starts XFCE over xrdp.
 *
 * SECURITY POSTURE (read before using)
 *  - The credential here is a DEDICATED DEMO credential for a throwaway,
 *    short-lived instance in a demo account — never a person's reusable
 *    password. It rides in EC2 userData, which is readable by anyone with
 *    `ec2:DescribeInstanceAttribute` in that account, so this MUST NOT be used
 *    outside local evaluation. Production keeps using the M8 pull path.
 *  - The injector refuses to render for a production config (fail-fast).
 *  - No key material is derived from public identifiers; the credential is the
 *    one the operator explicitly supplied for this demo listing.
 */

import type { LaunchSpec } from './provider.js';
import type { PreBootCredential, PreBootInjection, PreBootInjector } from './disk-injector.js';

/** Valid POSIX login name we are willing to create an account for. */
const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,30}$/;

export class CloudInitInjector implements PreBootInjector {
  constructor(private readonly opts: { production?: boolean } = {}) {
    if (opts.production) {
      throw new Error(
        'CloudInitInjector is evaluation-only: it places the demo credential in userData. ' +
          'Production must use the verified-instance-identity pull path (audit C3 / M8).',
      );
    }
  }

  async prepare(_spec: LaunchSpec, credential: PreBootCredential): Promise<PreBootInjection> {
    const username = credential.username.trim().toLowerCase();
    if (!USERNAME_RE.test(username)) {
      throw new Error('demo account username must match ^[a-z_][a-z0-9_-]{0,30}$');
    }
    const password = credential.password;
    if (password === undefined || password.length < 8) {
      throw new Error('demo account requires a password of at least 8 characters');
    }
    // chpasswd's text format is line-based `user:password`; a colon or newline
    // in the password would corrupt it. Refuse rather than emit a broken script.
    if (/[\r\n:]/.test(password)) {
      throw new Error('demo account password must not contain a colon or newline');
    }

    return { method: 'cloud-init', userData: renderCloudInit(username, password) };
  }
}

/**
 * Render the `#cloud-config` that provisions one demo desktop account. Exported
 * for direct unit testing of the rendered text.
 */
export function renderCloudInit(username: string, password: string): string {
  return `#cloud-config
# DisFAP local-evaluation workspace bootstrap (see cloud/cloud-init-injector.ts).
# Creates the licensed demo account and brings up XFCE over xrdp so the broker
# can open a real RDP pixel session. NOT for production.
users:
  - name: ${username}
    lock_passwd: false
    shell: /bin/bash
    groups: [users]
    # A demo credential, not a personal one. Account is destroyed with the VM.
ssh_pwauth: false
disable_root: true
chpasswd:
  expire: false
  users:
    - name: ${username}
      password: ${password}
      type: text
write_files:
  - path: /home/${username}/.xsession
    owner: ${username}:${username}
    permissions: '0755'
    content: |
      startxfce4
  - path: /etc/xrdp/startwm.sh
    permissions: '0755'
    content: |
      #!/bin/sh
      unset DBUS_SESSION_BUS_ADDRESS
      unset XDG_RUNTIME_DIR
      exec startxfce4
package_update: true
packages:
  - xrdp
  - xorgxrdp
  - xfce4
  - xfce4-terminal
  - dbus-x11
  - dbus-user-session
runcmd:
  - [ bash, -c, "sed -i 's/^new_cursors=true/new_cursors=false/' /etc/xrdp/xrdp.ini || true" ]
  - [ systemctl, enable, --now, xrdp ]
  - [ bash, -c, "adduser xrdp ssl-cert || true" ]
  - [ systemctl, restart, xrdp ]
  - [ bash, -c, "echo 'dfap workspace ready' > /var/log/dfap-workspace-ready" ]
final_message: "DisFAP demo workspace ready"
`;
}
