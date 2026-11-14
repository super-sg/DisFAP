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
 *
 * The desktop also carries a tiny, clearly-labelled DisFAP DEMO application
 * (`dfap-demo-app.py`) that auto-starts with the XFCE session. It exists so the
 * evaluation can show a real application opening on the rented Linux desktop
 * without installing the owner's commercial software. It is not the owner's
 * product and performs no authentication.
 */

import type { LaunchSpec } from './provider.js';
import type { PreBootCredential, PreBootInjection, PreBootInjector } from './disk-injector.js';

/** Valid POSIX login name we are willing to create an account for. */
const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,30}$/;

/**
 * A well-formed single-line OpenSSH public key. Validated because it is spliced
 * into the rendered cloud-config: anything else could break or inject YAML.
 */
const SSH_PUBKEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ssh-dss) [A-Za-z0-9+/]+={0,3}( [^\r\n]*)?$/;

export class CloudInitInjector implements PreBootInjector {
  private readonly sshPublicKey: string | undefined;

  constructor(private readonly opts: { production?: boolean; sshPublicKey?: string } = {}) {
    if (opts.production) {
      throw new Error(
        'CloudInitInjector is evaluation-only: it places the demo credential in userData. ' +
          'Production must use the verified-instance-identity pull path (audit C3 / M8).',
      );
    }
    const key = opts.sshPublicKey?.trim();
    if (key !== undefined && key !== '') {
      if (!SSH_PUBKEY_RE.test(key)) {
        throw new Error('sshPublicKey must be a single-line OpenSSH public key (ssh-ed25519/ssh-rsa/ecdsa/ssh-dss)');
      }
      this.sshPublicKey = key;
    }
  }

  async prepare(_spec: LaunchSpec, credential: PreBootCredential): Promise<PreBootInjection> {
    if (credential.demoOnly !== true) {
      throw new Error(
        'CloudInitInjector accepts only a fresh DisFAP demo credential; reusable licensed credentials must not enter EC2 userData',
      );
    }
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

    return { method: 'cloud-init', userData: renderCloudInit(username, password, this.sshPublicKey) };
  }
}

/**
 * Render the `#cloud-config` that provisions one demo desktop account. Exported
 * for direct unit testing of the rendered text.
 */
export function renderCloudInit(username: string, password: string, sshPublicKey?: string): string {
  // The evaluation host may carry a TEMPORARY, key-only SSH path so the operator
  // can watch first-boot progress (cloud-init logs) on a stock AMI. A public key
  // is not a secret and grants nothing beyond the SG's source /32. When absent,
  // the block is omitted entirely and no SSH path exists. It must live UNDER a
  // user entry: top-level `ssh_authorized_keys` is not a valid cloud-config key
  // and cloud-init silently ignored it, which made first-boot failures
  // impossible to diagnose. The demo account is destroyed with the instance.
  const sshBlock = sshPublicKey ? `    ssh_authorized_keys:\n      - ${sshPublicKey.trim()}\n` : '';
  // Sudo is only needed on the operator's temporary key-only SSH path, so it is
  // not present on a normal launch. The account and VM are disposable and the
  // SSH port is restricted to the single demo-host /32.
  const sudoBlock = sshPublicKey ? `    sudo: ALL=(ALL) NOPASSWD:ALL\n` : '';
  return `#cloud-config
# DisFAP local-evaluation workspace bootstrap (see cloud/cloud-init-injector.ts).
# Creates the licensed demo account and brings up XFCE over xrdp so the broker
# can open a real RDP pixel session. NOT for production.
users:
  - default
  - name: ${username}
    lock_passwd: false
    shell: /bin/bash
    groups: [users]
    # A demo credential, not a personal one. Account is destroyed with the VM.
${sshBlock}${sudoBlock}ssh_pwauth: false
disable_root: true
chpasswd:
  expire: false
  users:
    - name: ${username}
      password: ${password}
      type: text
write_files:
  - path: /usr/local/bin/dfap-demo-app.py
    permissions: '0755'
    content: |
${DEMO_APP_PY}
  - path: /usr/local/bin/dfap-install-desktop.sh
    permissions: '0755'
    content: |
${DESKTOP_INSTALL_SH}
runcmd:
  - [ bash, /usr/local/bin/dfap-install-desktop.sh, ${username} ]
final_message: "DisFAP demo workspace ready"
`;
}

/**
 * The desktop bootstrap, run by `runcmd` as an EXPLICIT `bash` invocation.
 *
 * Two first-boot hazards are handled here, both observed on a real launch:
 *  1. cloud-init prefixes its generated runcmd script with `#!/bin/sh`, so an
 *     inline multi-line command executes under dash and dies on
 *     `set -o pipefail` — the whole install silently never ran. A separate
 *     script invoked via `bash` avoids that entirely.
 *  2. `write_files` entries owned by the demo account failed with
 *     "Unknown user or group" because the account did not exist yet when the
 *     module ran. The per-user session files are therefore created here, after
 *     the account is guaranteed to exist, instead of via `write_files`.
 *
 * It also waits out the dpkg lock held by first-boot unattended-upgrades, which
 * would otherwise make the package install fail.
 *
 * Rendered with the 6-space YAML block indentation that `write_files` requires.
 */
const DESKTOP_INSTALL_SH = `      #!/bin/bash
      # Installs XFCE over xrdp for the rented demo desktop. Arguments: <login>.
      set -euxo pipefail
      USERNAME="$1"
      export DEBIAN_FRONTEND=noninteractive
      LOG=/var/log/dfap-workspace-install.log
      exec > >(tee -a "$LOG") 2>&1
      echo "=== $(date -u) starting workspace install for $USERNAME ==="

      # First boot on Ubuntu starts unattended-upgrades, which holds the dpkg lock.
      systemctl stop unattended-upgrades.service || true
      systemctl disable unattended-upgrades.service || true
      systemctl stop apt-daily.service apt-daily-upgrade.service || true

      # Keep xrdp from listening during package configuration. Readiness probes
      # TCP/3389; without this the session flips "ready" while XFCE is still
      # installing, and the browser connects to a half-built desktop.
      printf '#!/bin/sh\\nexit 101\\n' > /usr/sbin/policy-rc.d
      chmod 0755 /usr/sbin/policy-rc.d
      systemctl stop xrdp || true

      APT="apt-get -o DPkg::Lock::Timeout=600 -o Acquire::Retries=5 -o Acquire::http::Timeout=60"
      ok=0
      for attempt in 1 2 3 4 5; do
        if $APT update; then ok=1; break; fi
        echo "apt update attempt $attempt failed; retrying in 30s" >&2
        sleep 30
      done
      test "$ok" = 1

      # xrdp first, on its own: a postinst failure is distinguishable from an
      # XFCE package failure. The startwm.sh override is written AFTER install
      # (dpkg would otherwise overwrite an early copy with the distro default).
      echo "=== installing xrdp ==="
      $APT install -y --no-install-recommends xrdp xorgxrdp || {
        echo "xrdp install returned nonzero; retrying package configuration" >&2
        dpkg --configure -a || true
        $APT install -y --no-install-recommends xrdp xorgxrdp
      }

      # Defensive: some Ubuntu ARM images have produced a half-configured xrdp
      # package with no xrdp account. Repair it before starting the service.
      if ! getent passwd xrdp >/dev/null; then
        echo "xrdp account missing; creating system account" >&2
        adduser --system --group --home /run/xrdp --no-create-home --disabled-login xrdp
      fi
      dpkg --configure -a || true

      echo "=== installing XFCE ==="
      $APT install -y --no-install-recommends xfce4 xfce4-terminal dbus-x11 dbus-user-session python3-tk

      cat > /etc/xrdp/startwm.sh <<'STARTWM'
      #!/bin/sh
      unset DBUS_SESSION_BUS_ADDRESS
      unset XDG_RUNTIME_DIR
      exec startxfce4
      STARTWM
      chmod 0755 /etc/xrdp/startwm.sh

      # Per-user session files, created after the account exists. install -d
      # creates the parent .config/.cache as root, so fix the whole tree: XFCE
      # cannot create its own settings dir otherwise and starts a black session.
      install -d -o "$USERNAME" -g "$USERNAME" "/home/$USERNAME/.config/autostart"
      install -d -o "$USERNAME" -g "$USERNAME" "/home/$USERNAME/.cache"
      chown -R "$USERNAME:$USERNAME" "/home/$USERNAME/.config" "/home/$USERNAME/.cache"
      printf 'startxfce4\\n' > "/home/$USERNAME/.xsession"
      chown "$USERNAME:$USERNAME" "/home/$USERNAME/.xsession"
      chmod 0755 "/home/$USERNAME/.xsession"

      cat > "/home/$USERNAME/.config/autostart/dfap-demo.desktop" <<'DESKTOP'
      [Desktop Entry]
      Type=Application
      Name=DisFAP Demo Application
      Comment=Purpose-built DisFAP demonstration application
      Exec=/usr/bin/python3 /usr/local/bin/dfap-demo-app.py
      Terminal=false
      X-GNOME-Autostart-enabled=true
      DESKTOP
      chown "$USERNAME:$USERNAME" "/home/$USERNAME/.config/autostart/dfap-demo.desktop"

      sed -i 's/^new_cursors=true/new_cursors=false/' /etc/xrdp/xrdp.ini || true
      adduser xrdp ssl-cert || true
      rm -f /usr/sbin/policy-rc.d
      systemctl enable xrdp
      systemctl reset-failed xrdp || true
      systemctl restart xrdp
      systemctl is-active xrdp
      echo 'dfap workspace ready' > /var/log/dfap-workspace-ready
      echo "=== $(date -u) workspace install complete ==="
`;

/**
 * The DisFAP demonstration application installed into the rented desktop. It is
 * deliberately small and self-describing: it exists to prove that a real,
 * interactive Linux desktop is being streamed to the browser. It is NOT the
 * owner's software and it authenticates nothing.
 *
 * Rendered with the 6-space YAML block indentation that `write_files` requires.
 */
const DEMO_APP_PY = `      #!/usr/bin/env python3
      """DisFAP demonstration application (evaluation only).

      A tiny interactive window that proves the rented workspace is a real Linux
      desktop. It is not the owner's commercial software and performs no login.
      """
      import time
      import tkinter as tk

      BG = "#0f172a"
      PANEL = "#1e293b"
      FG = "#e2e8f0"
      MUTED = "#94a3b8"
      ACCENT = "#38bdf8"

      FONT = "DejaVu Sans"


      class DemoApp:
          def __init__(self, root):
              self.root = root
              self.count = 0
              root.title("DisFAP Demo Application")
              root.geometry("580x400")
              root.configure(bg=BG)

              tk.Label(root, text="DisFAP Demo Application", bg=BG, fg=ACCENT,
                       font=(FONT, 20, "bold")).pack(pady=(26, 2))
              tk.Label(root, text="Rented Linux workspace - live interactive session",
                       bg=BG, fg=FG, font=(FONT, 11)).pack(pady=(0, 16))

              card = tk.Frame(root, bg=PANEL, padx=18, pady=16)
              card.pack(fill="x", padx=26)
              tk.Label(card, text="This window is running inside the rented instance.",
                       bg=PANEL, fg=FG, font=(FONT, 10), wraplength=470,
                       justify="left").pack(anchor="w")
              tk.Label(card, text="It is a purpose-built DisFAP demo, not the owner's software.",
                       bg=PANEL, fg=FG, font=(FONT, 10), wraplength=470,
                       justify="left").pack(anchor="w", pady=(6, 0))

              self.status = tk.Label(root, text="Interactions: 0", bg=BG, fg=ACCENT,
                                     font=(FONT, 15, "bold"))
              self.status.pack(pady=(18, 8))
              tk.Button(root, text="Click to prove the session is live", command=self.bump,
                        bg=ACCENT, fg=BG, activebackground="#7dd3fc",
                        font=(FONT, 11, "bold"), relief="flat", padx=16, pady=8).pack()

              self.clock = tk.Label(root, text="", bg=BG, fg=MUTED, font=(FONT, 9))
              self.clock.pack(side="bottom", pady=10)
              self.tick()

          def bump(self):
              self.count += 1
              self.status.config(text="Interactions: %d" % self.count)

          def tick(self):
              self.clock.config(text=time.strftime("Guest time: %Y-%m-%d %H:%M:%S"))
              self.root.after(1000, self.tick)


      if __name__ == "__main__":
          win = tk.Tk()
          DemoApp(win)
          win.mainloop()
`;
