#!/usr/bin/env bash
# =============================================================================
# install-workspace.sh — install the RDP desktop workspace and lock down the
# RDP host channels (DisFAP isolation layer 3).
#
# Runs as root during the Packer build (invoked via `sudo -E bash`). It:
#   1. installs a MINIMAL XFCE desktop + xrdp + xorgxrdp (no desktop bloat)
#   2. creates the non-privileged 'session' user with a LOCKED password
#      (the control plane sets a per-session password via SSM at claim time —
#      no credential is ever baked into the image)
#   3. merges provision/xrdp-lockdown.ini into xrdp.ini so clipboard, drive,
#      printer, COM/LPT, and audio-in/out redirection are all disabled AT THE
#      HOST, and flips the master `allow_channels=false` switch
#   4. hardens sesman (no root login, kill-on-disconnect, restrict to a group)
#   5. removes the non-Xorg xrdp back-ends to shrink the attack surface
#
# Idempotent enough to re-run during iteration; safe under `set -e`.
# =============================================================================
set -Eeuo pipefail

# --- inputs (exported by the Packer shell provisioner) -----------------------
STAGE="${DFAP_STAGE:?DFAP_STAGE not set}"                 # e.g. /tmp/dfap-stage
SESSION_USER="${DFAP_SESSION_USER:-session}"
XRDP_INI="/etc/xrdp/xrdp.ini"
SESMAN_INI="/etc/xrdp/sesman.ini"
LOCKDOWN_FRAGMENT="${STAGE}/xrdp-lockdown.ini"

log() { printf '\n=== [install-workspace] %s ===\n' "$*"; }

# -----------------------------------------------------------------------------
log "apt: refresh + minimal desktop/xrdp install"
# -----------------------------------------------------------------------------
# --no-install-recommends keeps the footprint small: we explicitly name the few
# XFCE pieces we actually need for a usable session rather than the metapackage.
apt-get update -y
apt-get install -y --no-install-recommends \
  xrdp \
  xorgxrdp \
  xorg \
  xserver-xorg-core \
  dbus-x11 \
  xfce4-session \
  xfwm4 \
  xfdesktop4 \
  xfce4-panel \
  xfce4-settings \
  xfce4-terminal \
  thunar \
  policykit-1 \
  x11-xserver-utils \
  fonts-dejavu-core \
  ca-certificates \
  curl \
  jq \
  unzip \
  nftables \
  auditd audispd-plugins

# -----------------------------------------------------------------------------
log "aws cli v2 (required by the dead-man switch to self-terminate)"
# -----------------------------------------------------------------------------
# AWS CLI v2 is a self-contained bundle (not apt build tooling), so harden.sh's
# "strip build tooling" step will not remove it. Install only if absent.
if ! command -v aws >/dev/null 2>&1; then
  arch="$(uname -m)" # x86_64 or aarch64 — the CLI ships both
  tmpd="$(mktemp -d)"
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${arch}.zip" -o "${tmpd}/awscliv2.zip"
  unzip -q "${tmpd}/awscliv2.zip" -d "${tmpd}"
  "${tmpd}/aws/install" --update
  rm -rf "${tmpd}"
fi
aws --version

# -----------------------------------------------------------------------------
log "create non-privileged '${SESSION_USER}' user (password LOCKED)"
# -----------------------------------------------------------------------------
if ! id -u "${SESSION_USER}" >/dev/null 2>&1; then
  # No sudo group, no shell login secrets. Home is created for the XFCE profile.
  useradd --create-home --shell /bin/bash --user-group "${SESSION_USER}"
fi
# Lock the password so this bootstrap account cannot be logged into. The REAL
# session identity is created at first boot by dfap-provision.service (audit C3 /
# M8): a least-privilege account whose name and password come from the control
# plane over an instance-identity-authenticated pull — never baked into the
# image, never delivered as a shared key. `usermod -L` disables this one.
usermod --lock "${SESSION_USER}"
# Make absolutely sure the shadow entry is a locked placeholder, not empty
# (empty would allow passwordless login on a misconfigured PAM stack).
if getent shadow "${SESSION_USER}" | cut -d: -f2 | grep -qvE '^!|^\*'; then
  usermod -p '!' "${SESSION_USER}"
fi

# xrdp login restriction group: only members may open an RDP session (sesman
# AlwaysGroupCheck + TerminalServerUsers below). Root is never a member.
groupadd -f tsusers
usermod -aG tsusers "${SESSION_USER}"

# Per-user session command as a belt-and-braces fallback to startwm.sh.
install -d -m 0700 -o "${SESSION_USER}" -g "${SESSION_USER}" "/home/${SESSION_USER}"
cat > "/home/${SESSION_USER}/.xsession" <<'EOF'
# DisFAP session desktop entrypoint.
export XDG_SESSION_DESKTOP=xfce
export XDG_CURRENT_DESKTOP=XFCE
exec startxfce4
EOF
chown "${SESSION_USER}:${SESSION_USER}" "/home/${SESSION_USER}/.xsession"
chmod 0644 "/home/${SESSION_USER}/.xsession"

# A skeleton entrypoint so ANY account created later at first boot (i.e. the
# provisioned session identity) gets the same deterministic XFCE desktop as the
# bootstrap user. Username-agnostic: the login identity is the delivered
# license/app identity, not a hard-coded name (fixes the username mismatch).
install -d -m 0755 /etc/skel
cat > /etc/skel/.xsession <<'EOF'
# DisFAP session desktop entrypoint (skeleton; applied to every new account).
export XDG_SESSION_DESKTOP=xfce
export XDG_CURRENT_DESKTOP=XFCE
exec startxfce4
EOF
chmod 0644 /etc/skel/.xsession

# -----------------------------------------------------------------------------
log "point xrdp's global startwm.sh at XFCE"
# -----------------------------------------------------------------------------
# Ubuntu's stock startwm.sh execs Xsession which may launch GNOME if present.
# We install no GNOME; make the intent explicit and deterministic.
cat > /etc/xrdp/startwm.sh <<'EOF'
#!/bin/sh
# DisFAP: force the XFCE desktop for every xrdp session.
if [ -r /etc/profile ]; then . /etc/profile; fi
export XDG_SESSION_DESKTOP=xfce
export XDG_CURRENT_DESKTOP=XFCE
exec startxfce4
EOF
chmod 0755 /etc/xrdp/startwm.sh

# -----------------------------------------------------------------------------
log "merge channel lockdown into ${XRDP_INI} (isolation layer 3)"
# -----------------------------------------------------------------------------
# Surgical, comment-preserving edit done in Python (present on Ubuntu base):
#   * force allow_channels=false in [Globals] (master kill switch)
#   * force TLS security + high crypt floor in [Globals]
#   * replace the whole [Channels] section with the audited one from the fragment
# We do NOT use configparser (it drops comments and reorders); we edit the raw
# text with anchored regexes so the file stays human-diffable.
test -f "${LOCKDOWN_FRAGMENT}" || { echo "missing ${LOCKDOWN_FRAGMENT}" >&2; exit 1; }
cp -a "${XRDP_INI}" "${XRDP_INI}.orig"

python3 - "${XRDP_INI}" "${LOCKDOWN_FRAGMENT}" <<'PYEOF'
import re, sys

xrdp_path, fragment_path = sys.argv[1], sys.argv[2]
text = open(xrdp_path, encoding="utf-8").read()

# --- 1) pull the [Channels] block out of the audited fragment ----------------
frag = open(fragment_path, encoding="utf-8").read()
m = re.search(r'(?ms)^\[Channels\]\s*\n(.*?)(?=^\s*\[|\Z)', frag)
if not m:
    sys.exit("fragment has no [Channels] section")
# keep only real key=value lines (skip comments/blanks) for a clean block
chan_lines = [ln.strip() for ln in m.group(1).splitlines()
              if ln.strip() and not ln.strip().startswith((';', '#'))]
channels_block = "[Channels]\n" + "\n".join(chan_lines) + "\n"

def set_in_globals(txt, key, value):
    """Set key=value inside [Globals], updating in place or inserting."""
    # locate the [Globals] section span
    gm = re.search(r'(?ms)^\[Globals\]\s*\n(.*?)(?=^\s*\[|\Z)', txt)
    if not gm:
        # no [Globals]? prepend one
        return f"[Globals]\n{key}={value}\n\n" + txt
    body = gm.group(1)
    line_re = re.compile(r'(?mi)^\s*' + re.escape(key) + r'\s*=.*$')
    if line_re.search(body):
        new_body = line_re.sub(f"{key}={value}", body, count=1)
    else:
        new_body = f"{key}={value}\n" + body
    return txt[:gm.start(1)] + new_body + txt[gm.end(1):]

# --- 2) master switch + TLS/crypt floor in [Globals] -------------------------
for k, v in [
    ("allow_channels", "false"),  # <-- the load-bearing kill switch
    ("security_layer", "tls"),
    ("crypt_level", "high"),
    ("tls_ciphers", "HIGH"),
]:
    text = set_in_globals(text, k, v)

# --- 3) replace (or append) the [Channels] section ---------------------------
if re.search(r'(?ms)^\[Channels\]\s*\n', text):
    text = re.sub(r'(?ms)^\[Channels\]\s*\n.*?(?=^\s*\[|\Z)', channels_block + "\n", text, count=1)
else:
    text = text.rstrip() + "\n\n" + channels_block

open(xrdp_path, "w", encoding="utf-8").write(text)
print("xrdp.ini: allow_channels=false + [Channels] lockdown applied")
PYEOF

# Fail the build loudly if the master switch did not land.
grep -Eiq '^[[:space:]]*allow_channels[[:space:]]*=[[:space:]]*false' "${XRDP_INI}" \
  || { echo "FATAL: allow_channels=false not present in ${XRDP_INI}" >&2; exit 1; }

# -----------------------------------------------------------------------------
log "remove non-Xorg xrdp back-ends (shrink attack surface)"
# -----------------------------------------------------------------------------
# We only ever use the Xorg back-end. Neutralise the Xvnc / passthrough / RDP
# relay sections so a compromised broker cannot ask xrdp to proxy elsewhere.
python3 - "${XRDP_INI}" <<'PYEOF'
import re, sys
p = sys.argv[1]
text = open(p, encoding="utf-8").read()
for section in ("Xvnc", "vnc-any", "rdp-any", "neutrinordp-any"):
    text = re.sub(r'(?ms)^\[' + re.escape(section) + r'\]\s*\n.*?(?=^\s*\[|\Z)', "", text)
open(p, "w", encoding="utf-8").write(text)
print("removed non-Xorg back-ends from xrdp.ini")
PYEOF

# -----------------------------------------------------------------------------
log "harden sesman.ini (no root, group-restricted, kill-on-disconnect)"
# -----------------------------------------------------------------------------
cp -a "${SESMAN_INI}" "${SESMAN_INI}.orig"
python3 - "${SESMAN_INI}" <<'PYEOF'
import re, sys
p = sys.argv[1]
text = open(p, encoding="utf-8").read()

def set_in_section(txt, section, key, value):
    sm = re.search(r'(?ms)^\[' + re.escape(section) + r'\]\s*\n(.*?)(?=^\s*\[|\Z)', txt)
    if not sm:  # append the section if missing
        return txt.rstrip() + f"\n\n[{section}]\n{key}={value}\n"
    body = sm.group(1)
    line_re = re.compile(r'(?mi)^\s*' + re.escape(key) + r'\s*=.*$')
    body = line_re.sub(f"{key}={value}", body, count=1) if line_re.search(body) else f"{key}={value}\n" + body
    return txt[:sm.start(1)] + body + txt[sm.end(1):]

changes = [
    ("Security", "AllowRootLogin", "false"),
    ("Security", "MaxLoginRetry", "3"),
    ("Security", "TerminalServerUsers", "tsusers"),
    ("Security", "AlwaysGroupCheck", "true"),
    # Redundant with cliprdr=false but explicit — clipboard both directions off.
    ("Security", "RestrictOutboundClipboard", "all"),
    ("Security", "RestrictInboundClipboard", "all"),
    # A dropped RDP link ends the desktop session (burn-after-reading support).
    ("Sessions", "KillDisconnected", "true"),
    ("Sessions", "DisconnectedTimeLimit", "0"),
    # Idle policy is owned by the control plane; don't second-guess it here.
    ("Sessions", "IdleTimeLimit", "0"),
]
for sec, k, v in changes:
    text = set_in_section(text, sec, k, v)
open(p, "w", encoding="utf-8").write(text)
print("sesman.ini hardened")
PYEOF

# -----------------------------------------------------------------------------
log "polkit: suppress interactive auth dialogs inside RDP sessions"
# -----------------------------------------------------------------------------
# Colour-manager / NetworkManager / packagekit polkit prompts pop modal dialogs
# in an xrdp XFCE session — an annoyance AND a small UI surface. Deny them for
# non-local sessions so nothing waits on a password the session user must set.
install -d -m 0755 /etc/polkit-1/rules.d
cat > /etc/polkit-1/rules.d/49-dfap-no-prompts.rules <<'EOF'
/* DisFAP: never raise an interactive polkit prompt in a remote session.
 * These actions have no meaning in an ephemeral, single-user pixel session. */
polkit.addRule(function(action, subject) {
    if (subject.isInGroup("tsusers")) {
        if (action.id.indexOf("org.freedesktop.color-manager.") === 0 ||
            action.id.indexOf("org.freedesktop.NetworkManager.") === 0 ||
            action.id.indexOf("org.freedesktop.packagekit.") === 0 ||
            action.id === "org.freedesktop.login1.power-off" ||
            action.id === "org.freedesktop.login1.reboot") {
            return polkit.Result.NO;
        }
    }
});
EOF

# -----------------------------------------------------------------------------
log "guest credential provisioning assets (audit C3 / M8)"
# -----------------------------------------------------------------------------
# The guest half of the credential path: at first boot the unit proves this
# instance's identity to the control plane and materializes the session account.
# It is wired with a FAIL-CLOSED gate so xrdp/xrdp-sesman never start unless
# provisioning succeeded.
install -m 0755 "${STAGE}/provision/guest/dfap-provision.sh" /usr/local/sbin/dfap-provision.sh
install -m 0755 "${STAGE}/provision/guest/dfap-deprovision.sh" /usr/local/sbin/dfap-deprovision.sh
install -m 0644 "${STAGE}/systemd/dfap-provision.service" /etc/systemd/system/dfap-provision.service
install -d -m 0755 /etc/systemd/system/xrdp.service.d /etc/systemd/system/xrdp-sesman.service.d
install -m 0644 "${STAGE}/systemd/xrdp-gate.conf" /etc/systemd/system/xrdp.service.d/dfap-gate.conf
install -m 0644 "${STAGE}/systemd/xrdp-gate.conf" /etc/systemd/system/xrdp-sesman.service.d/dfap-gate.conf

install -d -m 0755 /etc/dfap
cat > /etc/dfap/provision.env <<'EOF'
# DisFAP guest credential provisioning (audit C3 / M8).
#
# FAIL CLOSED: while DFAP_PROVISIONING_ENABLED is not 1, the provisioning unit
# exits non-zero and the xrdp gate drop-in keeps the RDP listener DOWN — the VM
# exposes no login rather than one backed by a stale/absent account.
#
# Set BOTH only when the control plane's /internal/guest/provision endpoint is
# configured (DFAP_GUEST_PROVISIONING=instance-identity in a NON-production
# environment; production refuses it until real AWS identity verification is
# validated).
DFAP_PROVISIONING_ENABLED=0
DFAP_CONTROL_PLANE_URL=
DFAP_SESSION_GROUP=tsusers
DFAP_STATE_DIR=/var/lib/dfap
DFAP_RUN_DIR=/run/dfap
DFAP_MARKER=/var/lib/dfap/provisioned
EOF
chmod 0644 /etc/dfap/provision.env

# Operator/auditor guidance shipped in the image itself.
cat > /etc/dfap/guest-provisioning.md <<'EOF'
# Guest credential provisioning (DisFAP)

At first boot, `dfap-provision.service` runs `/usr/local/sbin/dfap-provision.sh`
BEFORE xrdp/xrdp-sesman. It:

  1. reads this instance's AWS-signed identity (IMDSv2 instance-identity
     document + signature, instance-id, ami-id, and the dfap:session_id tag);
  2. POSTs the signed identity to the control plane's
     /internal/guest/provision endpoint;
  3. validates the returned package STRICTLY and checks it against the local
     instance-id, image-id and session tag;
  4. creates a least-privilege account in `tsusers` with the delivered identity.

Properties: no credential is baked into this image; no shared decryption key
exists in this image; the credential is delivered once over TLS to an instance
whose identity is cryptographically verified, and only for the session the
control plane launched that instance for.

Fail-closed: if any step fails, the unit exits non-zero and the xrdp gate
drop-in (xrdp.service.d/dfap-gate.conf) prevents xrdp/xrdp-sesman from starting.
No usable remote-login surface exists before provisioning succeeds.
EOF
chmod 0644 /etc/dfap/guest-provisioning.md

# Enable the provisioning unit so the gate has something to require.
systemctl enable dfap-provision.service

# -----------------------------------------------------------------------------
log "enable xrdp at boot"
# -----------------------------------------------------------------------------
# xrdp needs the ssl-cert group to read its TLS key; add it as upstream expects.
adduser xrdp ssl-cert || true
systemctl enable xrdp
systemctl enable xrdp-sesman

# Don't start it during the build (we don't want a live listener on the builder);
# it comes up on the pool VM's first boot.
log "install-workspace complete"
