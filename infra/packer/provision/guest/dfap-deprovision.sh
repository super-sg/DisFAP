#!/usr/bin/env bash
# =============================================================================
# dfap-deprovision.sh — revoke a provisioned guest session account (M8).
#
# Idempotent. Invoked by the control plane on session termination (via SSM, when
# wired) and safe to run repeatedly. It removes the provisioned account(s) and
# their homes and forgets the provisioning marker.
#
# HONEST SCOPE: this is a best-effort, defence-in-depth cleanup on a VM that is
# ALSO destroyed (burn-after-reading, ADR-004) with its encrypted root volume.
# The authoritative cleanup is VM destruction; this script only narrows the
# window in which a still-live instance retains a usable account.
# =============================================================================
set -Eeuo pipefail

: "${DFAP_STATE_DIR:=/var/lib/dfap}"
: "${DFAP_MARKER:=${DFAP_STATE_DIR}/provisioned}"

log() { logger -t dfap-deprovision -- "$*" 2>/dev/null || printf 'dfap-deprovision: %s\n' "$*" >&2; }

# The accounts to remove are exactly those recorded in the marker (never a
# caller-supplied name): we only ever remove accounts this image provisioned.
if [[ -f "${DFAP_MARKER}" ]]; then
  # marker lines: <sessionTag>|<instanceId>|<fingerprint>|<username>
  while IFS='|' read -r _session _instance _fp user; do
    [[ -n "${user:-}" ]] || continue
    if id -u "${user}" >/dev/null 2>&1; then
      log "removing session account ${user}"
      userdel -r "${user}" 2>/dev/null || log "userdel ${user} failed (continuing)"
    fi
  done < "${DFAP_MARKER}"
  rm -f "${DFAP_MARKER}"
fi

# Belt-and-braces: the default session account, if it exists and is not root.
if [[ -n "${DFAP_DEFAULT_ACCOUNT:-}" && "${DFAP_DEFAULT_ACCOUNT}" != "root" ]]; then
  id -u "${DFAP_DEFAULT_ACCOUNT}" >/dev/null 2>&1 && userdel -r "${DFAP_DEFAULT_ACCOUNT}" 2>/dev/null || true
fi

log "deprovision complete"
exit 0
