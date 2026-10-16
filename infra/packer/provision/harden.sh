#!/usr/bin/env bash
# =============================================================================
# harden.sh — CIS-Level-1-style baseline for the DisFAP Linux session image,
# plus the guest dead-man switch and the in-guest egress firewall.
#
# Runs as root during the Packer build (invoked via `sudo -E bash`), AFTER
# install-workspace.sh. It performs ONLINE hardening — everything that is safe
# to apply to a running system. The immutable / last-mile hardening (chattr +i,
# log zeroing, host-key removal, machine-id wipe) is done LATER, on the
# unbooted volume, by offline-harden/harden-offline.sh. Splitting it this way
# is the product differentiator: the image never boots on a network in an
# un-finalised state.
#
# Sections:
#   1.  disable root login + lock the account
#   2.  SSH hardening + disable sshd at boot (admin access is SSM-only)
#   3.  remove/disable unused services (printing, avahi, rpcbind, ...)
#   4.  sysctl network/kernel hardening
#   5.  auditd rules
#   6.  password quality + login.defs + umask
#   7.  in-guest default-deny egress firewall (nftables) — layer-3 defence
#   8.  install the dead-man switch (units + script + heartbeat contract)
#   9.  disable at-rest mutation (unattended-upgrades / apt timers) — immutable
#   10. STRIP build tooling (compilers, headers, VCS) — done LAST
#
# NOTE: this script must NOT break xrdp login. SSH PasswordAuthentication=no
# only affects sshd; xrdp authenticates the 'session' user through its own PAM
# stack (pam xrdp-sesman), which is untouched.
# =============================================================================
set -Eeuo pipefail

SESSION_USER="${DFAP_SESSION_USER:-session}"
STAGE="${DFAP_STAGE:?DFAP_STAGE not set}"
# Optional: a real VPC CIDR enables the in-guest egress firewall. Left empty by
# default (the per-session security group is the authoritative egress control).
VPC_CIDR="${DFAP_VPC_CIDR:-}"

log() { printf '\n=== [harden] %s ===\n' "$*"; }

export DEBIAN_FRONTEND=noninteractive

# -----------------------------------------------------------------------------
log "1) lock root, disable root login"
# -----------------------------------------------------------------------------
passwd --lock root || true                # no password login for root
usermod -s /usr/sbin/nologin root || true # and no interactive shell
# Remove any password from the shadow file just in case the base set one.
usermod -p '!' root || true

# -----------------------------------------------------------------------------
log "2) SSH hardening + disable sshd at boot (admin is SSM-only)"
# -----------------------------------------------------------------------------
# We keep sshd RUNNING for the remainder of the Packer build (Packer's SSM/SSH
# session depends on it) but disable it at boot and drop a hardened config so
# that even if something re-enables it, it is locked down. The offline stage
# then strips the host keys. Admin access at runtime is exclusively AWS SSM.
install -d -m 0755 /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/60-dfap-hardening.conf <<'EOF'
# DisFAP SSH hardening (CIS L1). sshd is DISABLED at boot on session VMs;
# these settings apply only if it is ever manually started.
PermitRootLogin no
PasswordAuthentication no
PermitEmptyPasswords no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
PermitTunnel no
MaxAuthTries 3
MaxSessions 2
LoginGraceTime 30
ClientAliveInterval 300
ClientAliveCountMax 2
Banner none
Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com
MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com
KexAlgorithms curve25519-sha256,curve25519-sha256@libssh.org
EOF
# Validate before we rely on it (won't abort the build if binary missing).
sshd -t -f /etc/ssh/sshd_config 2>/dev/null || log "sshd -t reported issues (non-fatal at build time)"
# Disable at boot WITHOUT stopping the current session (no --now).
systemctl disable ssh 2>/dev/null || systemctl disable sshd 2>/dev/null || true

# -----------------------------------------------------------------------------
log "3) remove / disable unused services"
# -----------------------------------------------------------------------------
# Printing (cups) reinforces "no printer redirection"; the rest shrink surface.
apt-get purge -y \
  cups cups-daemon cups-browsed \
  avahi-daemon \
  rpcbind \
  telnet \
  nfs-common \
  || true

# Mask services that may still be present as deps so they can never start.
for svc in cups.service cups-browsed.service avahi-daemon.service \
           avahi-daemon.socket rpcbind.service rpcbind.socket \
           bluetooth.service ModemManager.service; do
  systemctl mask "${svc}" 2>/dev/null || true
done

# Keep: amazon-ssm-agent (admin plane), systemd-networkd/cloud-init (boot),
# chrony/systemd-timesyncd (time), xrdp, auditd. Ensure SSM stays enabled.
systemctl enable amazon-ssm-agent 2>/dev/null \
  || systemctl enable snap.amazon-ssm-agent.amazon-ssm-agent.service 2>/dev/null \
  || log "SSM agent unit name not found (installed on first boot on some AMIs)"

# -----------------------------------------------------------------------------
log "4) sysctl network/kernel hardening"
# -----------------------------------------------------------------------------
cat > /etc/sysctl.d/60-dfap-hardening.conf <<'EOF'
# --- DisFAP kernel/network hardening (CIS L1 subset) -------------------------
# Network: no routing, no redirects, source-route off, reverse-path filter on.
net.ipv4.ip_forward = 0
net.ipv6.conf.all.forwarding = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.default.secure_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv6.conf.default.accept_source_route = 0
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.log_martians = 1
net.ipv4.conf.default.log_martians = 1
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
net.ipv4.tcp_syncookies = 1
net.ipv6.conf.all.accept_ra = 0
net.ipv6.conf.default.accept_ra = 0

# Kernel: hide pointers, restrict dmesg/ptrace, no core dumps from setuid.
kernel.randomize_va_space = 2
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
kernel.yama.ptrace_scope = 1
kernel.perf_event_paranoid = 3
kernel.unprivileged_bpf_disabled = 1
net.core.bpf_jit_harden = 2
fs.suid_dumpable = 0
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
fs.protected_fifos = 2
fs.protected_regular = 2
EOF
sysctl --system >/dev/null 2>&1 || true

# Disable unused, exotic filesystems + network protocols (CIS module blocks).
cat > /etc/modprobe.d/60-dfap-blocklist.conf <<'EOF'
# DisFAP: refuse to load filesystems/protocols a session VM never needs.
install cramfs /bin/true
install freevxfs /bin/true
install jffs2 /bin/true
install hfs /bin/true
install hfsplus /bin/true
install udf /bin/true
install usb-storage /bin/true
install dccp /bin/true
install sctp /bin/true
install rds /bin/true
install tipc /bin/true
EOF

# Disable core dumps via limits + coredump.conf.
cat > /etc/security/limits.d/60-dfap-nocore.conf <<'EOF'
* hard core 0
* soft core 0
EOF
install -d -m 0755 /etc/systemd/coredump.conf.d
cat > /etc/systemd/coredump.conf.d/60-dfap.conf <<'EOF'
[Coredump]
Storage=none
ProcessSizeMax=0
EOF

# -----------------------------------------------------------------------------
log "5) auditd rules"
# -----------------------------------------------------------------------------
# auditd is installed in install-workspace.sh. Ship a CIS-flavoured rule set.
# `-e 2` at the end makes the config immutable until reboot; harmless in an
# image (reboot on the pool VM re-reads it). loginuid immutable prevents a user
# rewriting their own audit identity.
cat > /etc/audit/rules.d/60-dfap.rules <<'EOF'
## DisFAP auditd rules (CIS L1 subset)
-D
-b 8192
-f 1
--backlog_wait_time 60000

## Identity / auth changes
-w /etc/passwd -p wa -k identity
-w /etc/group -p wa -k identity
-w /etc/shadow -p wa -k identity
-w /etc/gshadow -p wa -k identity
-w /etc/sudoers -p wa -k scope
-w /etc/sudoers.d/ -p wa -k scope
-w /var/log/faillog -p wa -k logins
-w /var/log/lastlog -p wa -k logins

## Session / login records
-w /var/run/utmp -p wa -k session
-w /var/log/wtmp -p wa -k session
-w /var/log/btmp -p wa -k session

## sudo / privilege escalation
-w /var/log/sudo.log -p wa -k actions

## Time changes
-a always,exit -F arch=b64 -S adjtimex,settimeofday -k time-change
-a always,exit -F arch=b64 -S clock_settime -k time-change
-w /etc/localtime -p wa -k time-change

## Network config
-w /etc/hosts -p wa -k system-locale
-w /etc/hostname -p wa -k system-locale
-w /etc/netplan/ -p wa -k system-locale

## MAC policy
-w /etc/apparmor/ -p wa -k MAC-policy
-w /etc/apparmor.d/ -p wa -k MAC-policy

## Kernel module load/unload (attacker persistence)
-w /sbin/insmod -p x -k modules
-w /sbin/rmmod -p x -k modules
-w /sbin/modprobe -p x -k modules
-a always,exit -F arch=b64 -S init_module,delete_module -k modules

## DisFAP-specific: any tamper with the dead-man switch or its arming
-w /usr/local/sbin/dfap-deadman.sh -p wa -k dfap-deadman
-w /etc/systemd/system/dfap-deadman.service -p wa -k dfap-deadman
-w /etc/systemd/system/dfap-deadman.timer -p wa -k dfap-deadman
-w /var/lib/dfap/ -p wa -k dfap-deadman

## DisFAP-specific: guest credential provisioning (audit C3 / M8). Any write to
## the provisioning script/unit/config or its success marker is a security event.
-w /usr/local/sbin/dfap-provision.sh -p wa -k dfap-provision
-w /usr/local/sbin/dfap-deprovision.sh -p wa -k dfap-provision
-w /etc/systemd/system/dfap-provision.service -p wa -k dfap-provision
-w /etc/dfap/provision.env -p wa -k dfap-provision
-w /run/dfap/ -p wa -k dfap-provision

## Make the audit configuration immutable (must be the LAST rule)
-e 2
EOF
systemctl enable auditd 2>/dev/null || true
# Load now if the daemon is up; ignore failures during offline apply.
augenrules --load 2>/dev/null || true

# -----------------------------------------------------------------------------
log "6) password quality, login.defs, umask"
# -----------------------------------------------------------------------------
apt-get install -y --no-install-recommends libpam-pwquality || true
# Prefer the drop-in dir (Ubuntu 24.04 supports pwquality.conf.d); fall back to
# the monolithic file. mkdir -p is a no-op if the dir already exists.
mkdir -p /etc/security/pwquality.conf.d
if [[ -d /etc/security/pwquality.conf.d ]]; then
  PWQ_CONF=/etc/security/pwquality.conf.d/60-dfap.conf
else
  PWQ_CONF=/etc/security/pwquality.conf
fi
cat > "${PWQ_CONF}" <<'EOF'
# DisFAP password policy (CIS L1). The control plane sets the per-session
# 'session' password to a random 32+ char value, which satisfies this easily.
minlen = 14
minclass = 4
maxrepeat = 3
dcredit = 0
ucredit = 0
ocredit = 0
lcredit = 0
EOF

# login.defs: strong hashing + sane password aging + default umask 027.
sed -i \
  -e 's/^#\?\s*UMASK.*/UMASK 027/' \
  -e 's/^#\?\s*PASS_MAX_DAYS.*/PASS_MAX_DAYS 365/' \
  -e 's/^#\?\s*PASS_MIN_DAYS.*/PASS_MIN_DAYS 1/' \
  -e 's/^#\?\s*PASS_WARN_AGE.*/PASS_WARN_AGE 7/' \
  -e 's/^#\?\s*ENCRYPT_METHOD.*/ENCRYPT_METHOD YESCRYPT/' \
  /etc/login.defs || true

# System-wide restrictive umask for interactive shells.
cat > /etc/profile.d/60-dfap-umask.sh <<'EOF'
umask 027
EOF

# -----------------------------------------------------------------------------
log "7) in-guest default-deny egress firewall (nftables) — layer-3 defence"
# -----------------------------------------------------------------------------
# The AUTHORITATIVE egress control is the per-session security group (default
# deny + per-org allowlist, docs/security.md guarantee 3). This nftables policy
# is defence-in-depth inside the guest. It must permit exactly what the guest
# legitimately needs — crucially the EC2 API path the dead-man switch uses,
# which (in the no-NAT Phase-0 topology) is an EC2 *interface VPC endpoint*
# living in the VPC CIDR. So egress to the VPC CIDR is required for teardown.
#
# @@VPC_CIDR@@ is substituted below when DFAP_VPC_CIDR is a real CIDR; otherwise
# the ruleset is installed but the service is left DISABLED with a warning, so a
# wrong/empty CIDR can never silently break the dead-man switch.
install -d -m 0755 /etc/nftables.d
cat > /etc/nftables.conf <<'EOF'
#!/usr/sbin/nft -f
# DisFAP in-guest firewall (defence-in-depth; SG is authoritative).
flush ruleset

table inet dfap {
  chain input {
    type filter hook input priority 0; policy drop;
    iif "lo" accept
    ct state established,related accept
    ct state invalid drop
    # RDP from the VPC only (guacd's SG is the real gate; this narrows it).
    ip saddr @@VPC_CIDR@@ tcp dport 3389 ct state new accept
    # ICMP for path-MTU / diagnostics.
    ip protocol icmp icmp type { echo-request, destination-unreachable, time-exceeded } accept
    ip6 nexthdr ipv6-icmp accept
  }

  chain forward {
    type filter hook forward priority 0; policy drop;
  }

  chain output {
    type filter hook output priority 0; policy drop;
    oif "lo" accept
    ct state established,related accept
    # IMDSv2 (dead-man switch identity lookup).
    ip daddr 169.254.169.254 tcp dport 80 accept
    # DNS (Amazon-provided resolver lives in the VPC; broad-allow 53).
    udp dport 53 accept
    tcp dport 53 accept
    # NTP for clock (Amazon Time Sync is link-local 169.254.169.123).
    ip daddr 169.254.169.123 udp dport 123 accept
    # In-VPC HTTPS: EC2 interface endpoint (dead-man terminate) + guacd + SSM.
    ip daddr @@VPC_CIDR@@ tcp dport 443 accept
    ip daddr @@VPC_CIDR@@ tcp dport 3389 ct state new accept
    # Everything else denied. Per-org outbound allowances are added at the SG.
  }
}
EOF

if [[ -n "${VPC_CIDR}" && "${VPC_CIDR}" != "@@VPC_CIDR@@" ]]; then
  sed -i "s|@@VPC_CIDR@@|${VPC_CIDR}|g" /etc/nftables.conf
  # Validate syntax; only enable if it parses.
  if nft -c -f /etc/nftables.conf; then
    systemctl enable nftables
    log "nftables egress firewall ENABLED for VPC CIDR ${VPC_CIDR}"
  else
    systemctl disable nftables 2>/dev/null || true
    log "WARNING: nftables ruleset failed validation — left DISABLED"
  fi
else
  systemctl disable nftables 2>/dev/null || true
  log "WARNING: DFAP_VPC_CIDR not provided — nftables staged but DISABLED. The"
  log "         per-session security group remains the authoritative egress"
  log "         control. Set DFAP_VPC_CIDR at build time to enable in-guest."
fi

# -----------------------------------------------------------------------------
log "8) install the dead-man switch (units + script + heartbeat contract)"
# -----------------------------------------------------------------------------
install -m 0755 "${STAGE}/bin/dfap-deadman.sh" /usr/local/sbin/dfap-deadman.sh
install -m 0644 "${STAGE}/systemd/dfap-deadman.service" /etc/systemd/system/dfap-deadman.service
install -m 0644 "${STAGE}/systemd/dfap-deadman.timer"   /etc/systemd/system/dfap-deadman.timer

# Persistent state dir (arm marker) + config.
install -d -m 0750 /var/lib/dfap
install -d -m 0755 /etc/dfap

# /run is tmpfs and is recreated each boot; declare the heartbeat dir so it
# exists before the broker's first `touch`.
cat > /etc/tmpfiles.d/dfap.conf <<'EOF'
# DisFAP: heartbeat lives on tmpfs, created at boot.
d /run/dfap 0750 root root -
EOF

# Tunables for the dead-man switch (sourced by the service).
cat > /etc/dfap/deadman.env <<'EOF'
# DisFAP dead-man switch configuration. See /etc/dfap/heartbeat-contract.md.
DFAP_DEADMAN_THRESHOLD_SECS=600
DFAP_HEARTBEAT_FILE=/run/dfap/heartbeat
DFAP_ARM_MARKER=/var/lib/dfap/armed
# Set to 1 in a test image to log the decision without terminating.
DFAP_DRY_RUN=0
DFAP_LOCAL_POWEROFF=1
EOF

# The heartbeat contract, shipped in the image for operators/auditors.
cat > /etc/dfap/heartbeat-contract.md <<'EOF'
# DisFAP dead-man switch — heartbeat contract

This VM self-terminates (EC2 terminate-instances on itself) if it has been
CLAIMED but stops receiving a broker heartbeat. It is teardown layer 3 of five
(see docs/architecture.md) and the only one that survives total control-plane
loss.

## Files (the interface the control plane implements)

- **Arm marker** `/var/lib/dfap/armed` (persistent)
  Created ONCE at claim time by the control plane via SSM RunCommand:
      install -d -m 0750 /var/lib/dfap && touch /var/lib/dfap/armed
  Its existence arms the switch. While absent (warm pool / unclaimed) the
  switch is disarmed and never fires.

- **Heartbeat** `/run/dfap/heartbeat` (tmpfs)
  The broker refreshes it at least every ~60 s while the session is alive:
      touch /run/dfap/heartbeat
  Delivered as a single SSM SendCommand from trusted infrastructure.

## Rule

    reference = mtime(heartbeat) if it exists else mtime(arm marker)
    if now - reference > DFAP_DEADMAN_THRESHOLD_SECS (default 600s): terminate self

A VM armed but never heartbeated still dies after one threshold window, so a
broker that crashes before its first touch cannot leave a zombie.

## Tunables

`/etc/dfap/deadman.env` — threshold, file paths, DFAP_DRY_RUN (test images).

## IAM

The instance role is scoped to `ec2:TerminateInstances` on THIS instance only
(condition on the instance ARN / a self tag). Terraform owns that policy.
EOF

# Enable the timer so it starts on the pool VM's first boot.
systemctl enable dfap-deadman.timer 2>/dev/null || true

# -----------------------------------------------------------------------------
log "9) freeze at-rest mutation (unattended-upgrades / apt timers)"
# -----------------------------------------------------------------------------
# The image is rebuilt every 7 days (see README); a running session VM must NOT
# mutate itself. Disable background package changes so the image stays exactly
# as audited between rebuilds.
systemctl disable --now unattended-upgrades 2>/dev/null || true
systemctl mask apt-daily.service apt-daily.timer \
              apt-daily-upgrade.service apt-daily-upgrade.timer 2>/dev/null || true
apt-get purge -y unattended-upgrades || true

# -----------------------------------------------------------------------------
log "10) STRIP build tooling (compilers, headers, VCS) — LAST"
# -----------------------------------------------------------------------------
# Removing a local toolchain slows down an attacker who lands code execution.
# Done last so earlier steps could still build/compile if needed. We remove
# only unambiguously build-only packages; perl / binutils are deliberately kept
# because runtime components (cloud-init helpers, dpkg triggers) can depend on
# them and a cascade removal would break the image. The AWS CLI (a self-
# contained bundle) and python3 (needed by cloud-init) are retained.
apt-get purge -y \
  gcc g++ cpp make build-essential \
  gdb \
  autoconf automake libtool \
  pkg-config \
  cmake \
  git subversion mercurial \
  2>/dev/null || true

apt-get autoremove --purge -y || true
apt-get clean

log "harden complete"
