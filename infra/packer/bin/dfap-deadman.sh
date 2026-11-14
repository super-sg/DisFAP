#!/usr/bin/env bash
# =============================================================================
# dfap-deadman.sh — the guest dead-man switch (DisFAP teardown layer 3).
#
# Runs once per minute via dfap-deadman.timer. If this session VM has been
# CLAIMED but the broker's heartbeat file has not been refreshed within the
# threshold (default 10 min), the instance TERMINATES ITSELF via the EC2 API.
#
# Why this exists: it is the only teardown layer that survives *total*
# control-plane loss (docs/architecture.md, "five independent layers"). If the
# API, broker, and reaper are all dead, an orphaned billable VM still destroys
# itself. Its IAM role is scoped to terminate ONLY this instance (see README /
# Terraform), so a compromised guest gains nothing from holding these creds.
#
# ---- Heartbeat contract (the interface the broker/SSM implements) -----------
#   ARM MARKER   $DFAP_ARM_MARKER    (default /var/lib/dfap/armed, persistent)
#       Created ONCE at claim time (control plane, via SSM RunCommand). Its
#       existence means "this instance now belongs to a live session and MUST
#       be heartbeated." While absent, the switch is DISARMED — a warm-pool /
#       unclaimed instance never self-terminates.
#
#   HEARTBEAT    $DFAP_HEARTBEAT_FILE (default /run/dfap/heartbeat, tmpfs)
#       `touch`ed by the broker at least every ~60 s for as long as the session
#       is alive. Its mtime is the liveness signal. The broker touch is a single
#       SSM call: `touch /run/dfap/heartbeat`.
#
#   Liveness rule:
#       reference = mtime(HEARTBEAT) if it exists, else mtime(ARM_MARKER)
#       if (now - reference) > THRESHOLD  -> self-terminate
#   Using the arm marker as the fallback reference means a VM that was claimed
#   but never heartbeated (broker crashed before first touch) still dies after
#   one threshold window — no zombie survives an arm-without-heartbeat.
#
# All AWS calls use IMDSv2 (token-authenticated metadata). IMDSv1 is refused by
# the image's metadata options.
# =============================================================================
set -Eeuo pipefail

# --- configuration (overridable via /etc/dfap/deadman.env) -------------------
: "${DFAP_DEADMAN_THRESHOLD_SECS:=600}"          # 10 minutes
: "${DFAP_HEARTBEAT_FILE:=/run/dfap/heartbeat}"
: "${DFAP_ARM_MARKER:=/var/lib/dfap/armed}"
: "${DFAP_DRY_RUN:=0}"                            # 1 = log the decision, do not terminate
: "${DFAP_IMDS:=http://169.254.169.254}"
: "${DFAP_LOCAL_POWEROFF:=1}"                     # also poweroff locally if terminate lags

log() { logger -t dfap-deadman -- "$*" 2>/dev/null || true; printf 'dfap-deadman: %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# --- 0) disarmed? then this is a pool / unclaimed instance: nothing to do ----
if [[ ! -e "${DFAP_ARM_MARKER}" ]]; then
  log "disarmed (no arm marker at ${DFAP_ARM_MARKER}); unclaimed/pool instance — exiting"
  exit 0
fi

# --- 1) compute how stale the liveness signal is -----------------------------
now="$(date +%s)"
if [[ -e "${DFAP_HEARTBEAT_FILE}" ]]; then
  ref="$(stat -c %Y "${DFAP_HEARTBEAT_FILE}")"
  ref_src="heartbeat"
else
  # Armed but never heartbeated: fall back to the arm marker's own age.
  ref="$(stat -c %Y "${DFAP_ARM_MARKER}")"
  ref_src="arm-marker (no heartbeat yet)"
fi
age=$(( now - ref ))
log "armed; ${ref_src} age=${age}s threshold=${DFAP_DEADMAN_THRESHOLD_SECS}s"

if (( age <= DFAP_DEADMAN_THRESHOLD_SECS )); then
  exit 0   # fresh enough — the broker is (or recently was) alive
fi

log "STALE heartbeat: ${age}s > ${DFAP_DEADMAN_THRESHOLD_SECS}s — initiating self-termination"

# --- 2) identify self via IMDSv2 ---------------------------------------------
token="$(curl -fsS -m 5 -X PUT "${DFAP_IMDS}/latest/api/token" \
          -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')" \
  || die "IMDSv2 token request failed (is IMDS reachable / enabled?)"

imds_get() {
  curl -fsS -m 5 -H "X-aws-ec2-metadata-token: ${token}" "${DFAP_IMDS}/latest/meta-data/$1"
}
instance_id="$(imds_get instance-id)"      || die "could not read instance-id"
region="$(imds_get placement/region)"      || die "could not read region"
log "self=${instance_id} region=${region}"

# --- 3) terminate (or, in DRY_RUN, just report) ------------------------------
if [[ "${DFAP_DRY_RUN}" == "1" ]]; then
  log "DRY_RUN=1: would run 'aws ec2 terminate-instances --instance-ids ${instance_id} --region ${region}'"
  exit 0
fi

# The instance role is scoped to terminate ONLY this instance-id (Terraform).
if aws ec2 terminate-instances --region "${region}" --instance-ids "${instance_id}" >/dev/null; then
  log "terminate-instances issued for ${instance_id}"
else
  log "terminate-instances call FAILED — falling back to local poweroff"
fi

# --- 4) belt-and-braces: stop billing/attack surface even if the API lagged --
# Termination can take a few seconds; a local poweroff halts the guest now and
# also covers the case where the API call failed (e.g. transient endpoint loss).
if [[ "${DFAP_LOCAL_POWEROFF}" == "1" ]]; then
  log "local poweroff (best-effort)"
  systemctl poweroff --no-block || poweroff -f || true
fi
