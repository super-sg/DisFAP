#!/usr/bin/env bash
# =============================================================================
# dfap-provision.sh — DisFAP Linux guest credential provisioning (audit C3 / M8)
#
# Runs at first boot as a oneshot, BEFORE xrdp/xrdp-sesman are allowed to start.
# It is the guest half of the "credentials on the VM before login exposure"
# guarantee, and it FAILS CLOSED: if it does not succeed, xrdp never starts and
# no login is exposed (systemd ordering in dfap-xrdp-gate.conf enforces that).
#
# WHY THIS DESIGN (and not a sealed blob in userData)
#   A guest-side unseal of a control-plane blob needs key material in the guest.
#   A key baked into a reusable AMI is a shared secret across every instance of
#   that image — unacceptable. Instead the guest proves WHICH INSTANCE IT IS with
#   AWS's own RSA-signed EC2 instance identity document (IMDSv2), and the control
#   plane authorizes the credential for exactly that instance/session binding.
#   The guest never names its own session; it only presents its signed identity.
#
# SECRET HANDLING
#   * The credential arrives ONLY in the HTTPS response body, written to a
#     mode-0700 temp file and removed on exit (trap). It is never echoed, never
#     passed as an argument, never written to a log, and never placed in argv
#     (`chpasswd` reads it from stdin).
#   * Clearing a shell variable does not claim to physically erase memory.
#
# Modes:
#   (default)     provision this instance
#   --dry-run     do everything except create/alter the account
#   --self-test   run the payload-validation fixtures and exit (CI; no IMDS)
# =============================================================================
set -Eeuo pipefail

: "${DFAP_PROVISIONING_ENABLED:=0}"
: "${DFAP_CONTROL_PLANE_URL:=}"
: "${DFAP_IMDS:=http://169.254.169.254}"
: "${DFAP_STATE_DIR:=/var/lib/dfap}"
: "${DFAP_RUN_DIR:=/run/dfap}"
: "${DFAP_MARKER:=${DFAP_STATE_DIR}/provisioned}"
: "${DFAP_HTTP_TIMEOUT:=10}"
: "${DFAP_MAX_ATTEMPTS:=5}"
: "${DFAP_SESSION_GROUP:=tsusers}"
: "${DFAP_PROVISION_PATH:=/internal/guest/provision}"

log() { logger -t dfap-provision -- "$*" 2>/dev/null || printf 'dfap-provision: %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

MODE="provision"
case "${1:-}" in
  --dry-run)   MODE="dry-run" ;;
  --self-test) MODE="self-test" ;;
  "")          : ;;
  *)           die "unknown argument: $1" ;;
esac

# -----------------------------------------------------------------------------
# Payload validation — the SAME rules as the control plane's
# `validateProvisioningPackage` (services/api/src/guest/provisioning-package.ts).
# -----------------------------------------------------------------------------
# validate_package <file> [expected_session] [expected_instance] [expected_image]
validate_package() {
  local pkg="$1" es="${2:-}" ei="${3:-}" eim="${4:-}"
  jq -e '
    .v == 1
    and (.sessionId|type=="string" and length>0)
    and (.orgId|type=="string" and length>0)
    and (.templateId|type=="string" and length>0)
    and (.instanceId|type=="string" and length>0)
    and (.imageId|type=="string" and length>0)
    and (.osUsername|type=="string" and test("^[a-z_][a-z0-9_-]{0,31}$"))
    and (.osPassword|type=="string" and length>=16)
    and (.licenseId==null or (.licenseId|type=="string" and length>0))
    and (.appProfile==null or (.appProfile|type=="string" and length>0
         and test("^[a-z0-9][a-z0-9._-]{0,63}$")))
    and (.issuedAt|type=="string" and length>0)
    and (.expiresAt|type=="string" and length>0)
    and ((.expiresAt | sub("\\.[0-9]+Z$";"Z") | fromdateiso8601) > now)
  ' "${pkg}" >/dev/null 2>&1 || return 1
  if [[ -n "${es}" ]]; then [[ "$(jq -r '.sessionId' "${pkg}")" == "${es}" ]] || return 1; fi
  if [[ -n "${ei}" ]]; then [[ "$(jq -r '.instanceId' "${pkg}")" == "${ei}" ]] || return 1; fi
  if [[ -n "${eim}" ]]; then [[ "$(jq -r '.imageId' "${pkg}")" == "${eim}" ]] || return 1; fi
  return 0
}

# --- self-test: pin the shell validator to the same fixtures as the API tests -
if [[ "${MODE}" == "self-test" ]]; then
  command -v jq >/dev/null 2>&1 || die "self-test requires jq"
  tmp="$(mktemp -d)"; trap 'rm -rf "${tmp}"' EXIT
  far="$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+1H +%Y-%m-%dT%H:%M:%SZ)"
  near="$(date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)"
  good="$(jq -n --arg fa "${far}" '{v:1,sessionId:"ses_1",licenseId:null,orgId:"org_1",templateId:"tmpl_1",
    instanceId:"i-0123456789abcdef0",imageId:"ami-0123456789abcdef0",osUsername:"dfap-session",
    osPassword:"CorrectHorseBatteryStaple1",appProfile:null,issuedAt:"2026-01-01T00:00:00Z",expiresAt:$fa}')"
  printf '%s' "${good}" > "${tmp}/good.json"
  validate_package "${tmp}/good.json" "ses_1" "i-0123456789abcdef0" "ami-0123456789abcdef0" \
    || die "self-test: valid package was rejected"
  # wrong session binding
  validate_package "${tmp}/good.json" "ses_OTHER" && die "self-test: wrong-session accepted"
  # short password
  printf '%s' "${good}" | jq '.osPassword="short"' > "${tmp}/short.json"
  validate_package "${tmp}/short.json" && die "self-test: short password accepted"
  # bad username
  printf '%s' "${good}" | jq '.osUsername="Bad User!"' > "${tmp}/baduser.json"
  validate_package "${tmp}/baduser.json" && die "self-test: bad username accepted"
  # wrong version
  printf '%s' "${good}" | jq '.v=2' > "${tmp}/v2.json"
  validate_package "${tmp}/v2.json" && die "self-test: unknown version accepted"
  # expired
  printf '%s' "${good}" | jq --arg na "${near}" '.expiresAt=$na' > "${tmp}/expired.json"
  validate_package "${tmp}/expired.json" && die "self-test: expired package accepted"
  log "self-test OK"
  exit 0
fi

# -----------------------------------------------------------------------------
# Fail closed if provisioning is not enabled for this image.
# -----------------------------------------------------------------------------
if [[ "${DFAP_PROVISIONING_ENABLED}" != "1" ]]; then
  die "guest provisioning is not enabled (DFAP_PROVISIONING_ENABLED!=1); refusing to expose a login"
fi
[[ -n "${DFAP_CONTROL_PLANE_URL}" ]] || die "DFAP_CONTROL_PLANE_URL is not set"

umask 077
TMPDIR_PROV="$(mktemp -d)"
cleanup() { rm -rf "${TMPDIR_PROV}"; }
trap cleanup EXIT INT TERM

# -----------------------------------------------------------------------------
# 1) IMDSv2 identity: instance id, image id, signed document + signature.
# -----------------------------------------------------------------------------
imds_token="$(curl -fsS -m "${DFAP_HTTP_TIMEOUT}" -X PUT "${DFAP_IMDS}/latest/api/token" \
  -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')" || die "IMDSv2 token request failed"
imds_get() { curl -fsS -m "${DFAP_HTTP_TIMEOUT}" -H "X-aws-ec2-metadata-token: ${imds_token}" \
  "${DFAP_IMDS}/latest/meta-data/$1"; }

instance_id="$(imds_get instance-id)" || die "could not read instance-id"
image_id="$(imds_get ami-id)"        || die "could not read ami-id"
# The control-plane-stamped session tag: the guest's independent cross-check.
session_tag="$(imds_get "tags/instance/dfap:session_id" 2>/dev/null || true)"
[[ -n "${session_tag}" ]] || die "instance is not claimed for a session (no dfap:session_id tag)"

imds_get instance-identity/document  > "${TMPDIR_PROV}/doc.json"  || die "could not read instance identity document"
imds_get instance-identity/signature > "${TMPDIR_PROV}/sig.b64"  || die "could not read instance identity signature"
doc_b64="$(base64 -w0 < "${TMPDIR_PROV}/doc.json")"
sig_b64="$(tr -d '\n' < "${TMPDIR_PROV}/sig.b64")"

# -----------------------------------------------------------------------------
# 2) Request the credential. Retry on transient unavailability; never log body.
# -----------------------------------------------------------------------------
request_body="$(jq -n --arg d "${doc_b64}" --arg s "${sig_b64}" '{document:$d,signature:$s}')"
attempt=0
until curl -fsS -m "${DFAP_HTTP_TIMEOUT}" -X POST \
      -H 'content-type: application/json' \
      --data "${request_body}" \
      "${DFAP_CONTROL_PLANE_URL%/}${DFAP_PROVISION_PATH}" -o "${TMPDIR_PROV}/pkg.json"; do
  attempt=$((attempt + 1))
  [[ "${attempt}" -lt "${DFAP_MAX_ATTEMPTS}" ]] || die "provisioning request failed after ${attempt} attempts"
  log "provisioning request failed (attempt ${attempt}); retrying"
  sleep "$((attempt * 2))"
done

# -----------------------------------------------------------------------------
# 3) Strict validation + binding to what we independently know.
# -----------------------------------------------------------------------------
validate_package "${TMPDIR_PROV}/pkg.json" "${session_tag}" "${instance_id}" "${image_id}" \
  || die "control-plane package failed validation/binding check"

os_user="$(jq -r '.osUsername' "${TMPDIR_PROV}/pkg.json")"
os_pass="$(jq -r '.osPassword' "${TMPDIR_PROV}/pkg.json")"
app_profile="$(jq -r '.appProfile // empty' "${TMPDIR_PROV}/pkg.json")"

# -----------------------------------------------------------------------------
# 4) Idempotency / replay: same session+instance+credential ⇒ already done.
#    A DIFFERENT credential for the same session is a rotation and is applied.
# -----------------------------------------------------------------------------
fingerprint="$(printf '%s\0%s' "${os_user}" "${os_pass}" | sha256sum | awk '{print $1}')"
marker_line="${session_tag}|${instance_id}|${fingerprint}|${os_user}"
if [[ -f "${DFAP_MARKER}" ]] && grep -qxF "${marker_line}" "${DFAP_MARKER}"; then
  log "already provisioned for ${session_tag} (idempotent); nothing to do"
  exit 0
fi

# -----------------------------------------------------------------------------
# 5) Materialize the least-privilege session account.
# -----------------------------------------------------------------------------
create_account() {
  local user="$1" pass="$2"
  id -u "${user}" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --user-group "${user}" \
    || die "useradd failed for ${user}"
  # Group-gated RDP login (sesman TerminalServerUsers/AlwaysGroupCheck).
  usermod -aG "${DFAP_SESSION_GROUP}" "${user}" || die "group add failed for ${user}"
  # Privilege escalation must be impossible for the session account.
  if id -nG "${user}" 2>/dev/null | tr ' ' '\n' | grep -qxE 'sudo|admin|adm|wheel'; then
    die "refusing: ${user} is in a privileged group"
  fi
  # Password via stdin only — never argv, never a log.
  printf '%s:%s\n' "${user}" "${pass}" | chpasswd || die "chpasswd failed for ${user}"
  install -d -m 0700 -o "${user}" -g "${user}" "/home/${user}"
  if [[ -f /etc/skel/.xsession ]]; then
    install -m 0644 -o "${user}" -g "${user}" /etc/skel/.xsession "/home/${user}/.xsession"
  fi
  # Application/profile mapping: the image resolves the profile id to a
  # pre-installed application launched for this account. The rentee never gets
  # the owner's separate secrets — only this login, whose password the OS hashes.
  if [[ -n "${app_profile}" ]]; then
    install -d -m 0700 -o "${user}" -g "${user}" "/home/${user}/.config/dfap"
    printf 'profile=%s\n' "${app_profile}" > "/home/${user}/.config/dfap/profile"
    chown "${user}:${user}" "/home/${user}/.config/dfap/profile"
    chmod 0600 "/home/${user}/.config/dfap/profile"
  fi
}

if [[ "${MODE}" == "dry-run" ]]; then
  log "dry-run: would create account ${os_user} (app profile: ${app_profile:-none}) for ${session_tag}"
else
  create_account "${os_user}" "${os_pass}"
fi

# -----------------------------------------------------------------------------
# 6) Record success (non-secret fingerprint only) and arm the switch.
# -----------------------------------------------------------------------------
if [[ "${MODE}" != "dry-run" ]]; then
  install -d -m 0750 "${DFAP_STATE_DIR}" "${DFAP_RUN_DIR}"
  { grep -vxF -- "-" "${DFAP_MARKER}" 2>/dev/null || true; printf '%s\n' "${marker_line}"; } \
    > "${DFAP_MARKER}.tmp"
  chmod 0600 "${DFAP_MARKER}.tmp"
  mv "${DFAP_MARKER}.tmp" "${DFAP_MARKER}"
fi

# Drop the credential from this process's environment/memory as far as a shell
# honestly can (see file header: this is not a claim of physical erasure).
os_pass=""
unset os_pass

log "provisioning complete for session ${session_tag} on ${instance_id}"
exit 0
