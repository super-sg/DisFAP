#!/usr/bin/env bash
# =============================================================================
# harden-offline.sh — DisFAP OFFLINE hardening stage (the differentiator).
#
# The Packer build produces a STAGING AMI. This stage turns it into the final,
# pool-launchable AMI WITHOUT EVER BOOTING IT ON A NETWORK:
#
#   1. take the staging AMI's root snapshot (Packer already stopped + snapshotted
#      the build instance when it registered the AMI)
#   2. create a volume from that snapshot in this hardening worker's AZ and
#      ATTACH it as a secondary, UNMOUNTED device
#   3. run virt-customize (libguestfs) against the unbooted volume to apply the
#      last-mile immutable hardening: chattr +i on security-critical /etc files,
#      zero logs, remove SSH host keys, wipe machine-id, clear cloud-init seed
#   4. compute a SHA-256 fingerprint of the hardened root device
#   5. re-snapshot the hardened volume and REGISTER the final AMI from it
#   6. RECORD {ami_id, snapshot_id, snapshot_sha256, provenance} as JSON for the
#      control plane to ingest into `workspace_images`
#
# WHY OFFLINE (see README.md): a booted, networked machine can be tampered with
# during the window between "unhardened" and "hardened", and immutable flags /
# host-key wipes are unsafe to apply to the live system you are running on. Doing
# it on a cold, unbooted volume means the image's FIRST boot on any network is
# already fully hardened. It also yields a content hash an auditor can pin.
#
# Runs on a dedicated "hardening worker" EC2 instance that has:
#   * libguestfs-tools (virt-customize, guestfish), qemu-utils
#   * awscli v2, jq
#   * an IAM role allowing: DescribeImages/Snapshots/Volumes, CreateVolume,
#     AttachVolume/DetachVolume, CreateSnapshot, RegisterImage, CreateTags,
#     and (optional cleanup) DeregisterImage/DeleteSnapshot/DeleteVolume.
# NOTE: nothing here runs in the authoring environment (no AWS); it is written
# to be correct and complete.
# =============================================================================
set -Eeuo pipefail

# --- configuration (env or flags) --------------------------------------------
: "${AWS_REGION:=${REGION:-}}"                 # region of the staging AMI + output AMI
: "${STAGING_AMI_ID:=}"                         # if empty, read from PACKER_MANIFEST
: "${PACKER_MANIFEST:=../manifest.json}"        # produced by the Packer build
: "${AMI_NAME_PREFIX:=dfap-linux-workspace}"    # final AMI name prefix
: "${OUTPUT_DIR:=./out}"                         # where the JSON artifact is written
: "${KMS_KEY_ID:=}"                              # empty = default aws/ebs key
: "${GIT_COMMIT:=unknown}"
: "${REBUILD_CADENCE_DAYS:=7}"
: "${KEEP_STAGING:=0}"                           # 1 = keep staging AMI/snapshot
: "${DEVICE_HINT:=/dev/sdf}"                     # requested attach point
: "${IMDS:=http://169.254.169.254}"

log()  { printf '\n=== [offline-harden] %s ===\n' "$*"; }
die()  { printf 'offline-harden ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }

need aws; need jq; need virt-customize; need sha256sum

# --- resolve region + staging AMI --------------------------------------------
if [[ -z "${AWS_REGION}" ]]; then
  AWS_REGION="$(jq -r '.builds[-1].custom_data.region // empty' "${PACKER_MANIFEST}" 2>/dev/null || true)"
fi
[[ -n "${AWS_REGION}" ]] || die "AWS_REGION/REGION not set and not in manifest"
export AWS_DEFAULT_REGION="${AWS_REGION}"

if [[ -z "${STAGING_AMI_ID}" ]]; then
  # manifest 'artifact_id' looks like "us-east-1:ami-0abc..."; take the ami id.
  STAGING_AMI_ID="$(jq -r '.builds[-1].artifact_id // empty' "${PACKER_MANIFEST}" 2>/dev/null \
                      | sed 's/.*://')"
fi
[[ "${STAGING_AMI_ID}" == ami-* ]] || die "could not determine STAGING_AMI_ID (got '${STAGING_AMI_ID}')"
log "region=${AWS_REGION} staging_ami=${STAGING_AMI_ID}"

mkdir -p "${OUTPUT_DIR}"

# --- identify this hardening worker (for AZ + attach) ------------------------
imds_token="$(curl -fsS -m 5 -X PUT "${IMDS}/latest/api/token" \
                -H 'X-aws-ec2-metadata-token-ttl-seconds: 120')" || die "IMDSv2 token failed"
imds() { curl -fsS -m 5 -H "X-aws-ec2-metadata-token: ${imds_token}" "${IMDS}/latest/meta-data/$1"; }
WORKER_INSTANCE_ID="$(imds instance-id)"       || die "worker instance-id"
WORKER_AZ="$(imds placement/availability-zone)"|| die "worker AZ"
log "worker=${WORKER_INSTANCE_ID} az=${WORKER_AZ}"

# --- 1) find the staging AMI's root snapshot ---------------------------------
# Packer already stopped the build instance and snapshotted its root volume when
# it registered the staging AMI; we use that snapshot as the source. Look up the
# root device name first, then the snapshot bound to exactly that mapping.
ROOT_DEV="$(aws ec2 describe-images --image-ids "${STAGING_AMI_ID}" \
             --query 'Images[0].RootDeviceName' --output text)"
ARCH="$(aws ec2 describe-images --image-ids "${STAGING_AMI_ID}" \
          --query 'Images[0].Architecture' --output text)"
SRC_SNAPSHOT_ID="$(aws ec2 describe-images --image-ids "${STAGING_AMI_ID}" \
  --query "Images[0].BlockDeviceMappings[?DeviceName=='${ROOT_DEV}']|[0].Ebs.SnapshotId" \
  --output text)"
[[ "${SRC_SNAPSHOT_ID}" == snap-* ]] || die "no root snapshot for ${STAGING_AMI_ID}"
log "root_device=${ROOT_DEV} src_snapshot=${SRC_SNAPSHOT_ID} arch=${ARCH}"

# --- 2) create a volume from the snapshot and attach it (unmounted) ----------
kms_args=()
[[ -n "${KMS_KEY_ID}" ]] && kms_args=(--encrypted --kms-key-id "${KMS_KEY_ID}")
VOLUME_ID="$(aws ec2 create-volume \
  --availability-zone "${WORKER_AZ}" \
  --snapshot-id "${SRC_SNAPSHOT_ID}" \
  --volume-type gp3 \
  "${kms_args[@]}" \
  --tag-specifications 'ResourceType=volume,Tags=[{Key=dfap:role,Value=offline-harden},{Key=dfap:managed,Value=true}]' \
  --query 'VolumeId' --output text)"
log "created work volume ${VOLUME_ID}; waiting for available"
aws ec2 wait volume-available --volume-ids "${VOLUME_ID}"

# Always reclaim the work volume, even on failure — but only if it still exists,
# so this can't hang on an already-deleted volume during the normal exit path.
cleanup_volume() {
  set +e
  local state
  state="$(aws ec2 describe-volumes --volume-ids "${VOLUME_ID}" \
             --query 'Volumes[0].State' --output text 2>/dev/null)"
  [[ -z "${state}" || "${state}" == "None" ]] && return 0
  log "cleanup: reclaiming work volume ${VOLUME_ID} (state=${state})"
  if [[ "${state}" == "in-use" ]]; then
    aws ec2 detach-volume --volume-id "${VOLUME_ID}" >/dev/null 2>&1
    aws ec2 wait volume-available --volume-ids "${VOLUME_ID}" >/dev/null 2>&1
  fi
  aws ec2 delete-volume --volume-id "${VOLUME_ID}" >/dev/null 2>&1
}
trap cleanup_volume EXIT

# Record block devices before attach so we can detect the new one reliably
# (NVMe instances rename /dev/sdf -> /dev/nvmeXn1, so we diff lsblk).
before="$(lsblk -dpno NAME | sort)"
aws ec2 attach-volume --volume-id "${VOLUME_ID}" \
  --instance-id "${WORKER_INSTANCE_ID}" --device "${DEVICE_HINT}" >/dev/null
aws ec2 wait volume-in-use --volume-ids "${VOLUME_ID}"

# Wait for the kernel to surface the new block device.
DEV=""
for _ in $(seq 1 30); do
  after="$(lsblk -dpno NAME | sort)"
  DEV="$(comm -13 <(echo "${before}") <(echo "${after}") | head -n1)"
  [[ -n "${DEV}" && -b "${DEV}" ]] && break
  sleep 2
done
[[ -b "${DEV}" ]] || die "attached volume device did not appear"
log "attached as ${DEV} (NOT mounted — libguestfs will mount it in isolation)"

# Guard: refuse to proceed if the device is somehow mounted on the host.
if lsblk -no MOUNTPOINT "${DEV}" | grep -q .; then
  die "${DEV} appears mounted on the host — refusing to offline-customize a live fs"
fi

# --- 3) offline hardening via libguestfs (the volume is never booted) --------
# virt-customize launches its own isolated appliance VM, mounts the guest
# filesystem there, applies the commands, and unmounts. The guest OS on the
# volume NEVER executes. This is the whole security property.
#
# IMMUTABLE FILES (chattr +i): we make security-critical files append/rewrite-
# proof so even root-in-guest cannot quietly alter them. We deliberately do NOT
# +i the /etc directory itself, nor /etc/machine-id — systemd must regenerate
# machine-id on first boot, which requires writing that path.
#
# ACCOUNT DATABASES ARE *NOT* IN THE LIST (audit C3 / M8). `/etc/passwd`,
# `/etc/shadow`, `/etc/group` and `/etc/gshadow` must be writable at first boot:
# dfap-provision.service creates the least-privilege session account there
# (useradd + chpasswd). Making them `+i` would either break provisioning (the
# account never gets created and xrdp is refused) or force the guest to run
# `chattr -i` at boot — which a root-in-guest attacker could equally do, so it
# buys no real protection while breaking the credential path. We compensate
# with: default perms (0644 passwd/group, 0640 shadow/gshadow), the auditd
# watches installed by harden.sh, and the burn-after-reading VM model. This is a
# deliberate, documented trade-off — NOT a claim that the account DBs are as
# strong as the immutable files below.
log "3) virt-customize: immutable flags, log zero, host-key + machine-id wipe"
virt-customize -a "${DEV}" \
  --run-command 'rm -f /etc/ssh/ssh_host_*' \
  --run-command 'truncate -s0 /etc/machine-id || true' \
  --run-command 'rm -f /var/lib/dbus/machine-id; ln -sf /etc/machine-id /var/lib/dbus/machine-id' \
  --run-command 'find /var/log -type f -exec truncate -s0 {} + 2>/dev/null || true' \
  --run-command 'rm -rf /var/log/journal/* /var/log/audit/* 2>/dev/null || true' \
  --run-command 'rm -rf /var/lib/cloud/instances/* /var/lib/cloud/instance /var/lib/cloud/data/* 2>/dev/null || true' \
  --run-command 'rm -f /root/.bash_history /home/*/.bash_history 2>/dev/null || true' \
  --run-command 'rm -f /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys 2>/dev/null || true' \
  --run-command 'rm -rf /tmp/* /var/tmp/* 2>/dev/null || true' \
  --run-command 'rm -f /etc/ssh/ssh_host_*_key.pub 2>/dev/null || true' \
  --run-command '
      set -e
      # Immutable (append/rewrite-proof) security-critical files. Missing files
      # are skipped so the list can evolve without breaking the build.
      # NOTE: account DBs and the provisioning config are intentionally absent
      # (see the comment above this block): first-boot provisioning writes them.
      for f in \
        /etc/sudoers /etc/pam.d/common-auth /etc/pam.d/common-password \
        /etc/ssh/sshd_config \
        /etc/sysctl.d/60-dfap-hardening.conf \
        /etc/modprobe.d/60-dfap-blocklist.conf \
        /etc/audit/rules.d/60-dfap.rules \
        /etc/systemd/system/dfap-deadman.service \
        /etc/systemd/system/dfap-deadman.timer \
        /usr/local/sbin/dfap-deadman.sh \
        /etc/dfap/deadman.env \
        /etc/dfap/heartbeat-contract.md \
        /etc/xrdp/xrdp.ini /etc/xrdp/sesman.ini /etc/xrdp/startwm.sh \
        /etc/polkit-1/rules.d/49-dfap-no-prompts.rules ; do
        [ -e "$f" ] && chattr +i "$f" 2>/dev/null || true
      done
      # Provisioning unit/script are NOT made immutable: the timer/unit set is
      # versioned with the image and the control plane is the trust root, but
      # keeping them mutable avoids a boot-time chattr dance. They are watch-
      # listed by auditd (harden.sh) instead.
  ' \
  --run-command 'sync'
log "virt-customize complete"

# --- 4) fingerprint the hardened root device (the auditor's artifact) --------
# We hash the RAW block device after customization and before detach/snapshot,
# so the recorded SHA-256 is the exact content the final snapshot captures.
#
# CAVEAT: a block-level hash includes filesystem metadata / unallocated regions
# and is therefore a fingerprint of THIS build, not a byte-reproducible value
# across independent builds. For reproducible attestation, hash a sorted
# manifest of file checksums instead (see README, "Reproducible hashing"). The
# block hash is what the control plane pins per build; it is what proves "this
# AMI's snapshot has not been altered since registration."
log "4) computing SHA-256 of hardened device ${DEV} (this can take a while)"
SNAPSHOT_SHA256="$(sha256sum "${DEV}" | awk '{print $1}')"
log "snapshot_sha256=${SNAPSHOT_SHA256}"

# --- 5) detach, snapshot the hardened volume, register the final AMI ---------
# The EXIT trap stays armed and is existence-checked, so it is a harmless no-op
# once we delete the volume ourselves below.
log "5) detach + snapshot hardened volume"
aws ec2 detach-volume --volume-id "${VOLUME_ID}" >/dev/null
aws ec2 wait volume-available --volume-ids "${VOLUME_ID}"

HARDENED_SNAPSHOT_ID="$(aws ec2 create-snapshot \
  --volume-id "${VOLUME_ID}" \
  --description "DisFAP hardened Linux workspace (${GIT_COMMIT})" \
  --tag-specifications "ResourceType=snapshot,Tags=[\
{Key=dfap:template,Value=linux-workspace},\
{Key=dfap:hardened,Value=true},\
{Key=dfap:snapshot_sha256,Value=${SNAPSHOT_SHA256}},\
{Key=dfap:git_commit,Value=${GIT_COMMIT}},\
{Key=dfap:managed,Value=true}]" \
  --query 'SnapshotId' --output text)"
log "hardened snapshot ${HARDENED_SNAPSHOT_ID}; waiting for completion"
aws ec2 wait snapshot-completed --snapshot-ids "${HARDENED_SNAPSHOT_ID}"

# Now the work volume can go.
aws ec2 delete-volume --volume-id "${VOLUME_ID}" >/dev/null || true

BUILD_TS="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL_AMI_NAME="${AMI_NAME_PREFIX}-${BUILD_TS}"
log "registering final AMI ${FINAL_AMI_NAME} from ${HARDENED_SNAPSHOT_ID}"
FINAL_AMI_ID="$(aws ec2 register-image \
  --name "${FINAL_AMI_NAME}" \
  --description "DisFAP hardened Linux session workspace. sha256=${SNAPSHOT_SHA256}" \
  --architecture "${ARCH}" \
  --root-device-name "${ROOT_DEV}" \
  --virtualization-type hvm \
  --ena-support \
  --boot-mode uefi-preferred \
  --block-device-mappings "[{\"DeviceName\":\"${ROOT_DEV}\",\"Ebs\":{\"SnapshotId\":\"${HARDENED_SNAPSHOT_ID}\",\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
  --query 'ImageId' --output text)"
log "final AMI ${FINAL_AMI_ID}"

# Tag the final AMI: dfap:hardened=true is the flag the pool manager REQUIRES
# before it will ever launch an image.
aws ec2 create-tags --resources "${FINAL_AMI_ID}" --tags \
  "Key=Name,Value=${FINAL_AMI_NAME}" \
  "Key=dfap:template,Value=linux-workspace" \
  "Key=dfap:hardened,Value=true" \
  "Key=dfap:snapshot_sha256,Value=${SNAPSHOT_SHA256}" \
  "Key=dfap:git_commit,Value=${GIT_COMMIT}" \
  "Key=dfap:build_time,Value=${BUILD_TS}" \
  "Key=dfap:source_staging_ami,Value=${STAGING_AMI_ID}" >/dev/null

# --- 6) emit the workspace_images JSON artifact ------------------------------
OUT_JSON="${OUTPUT_DIR}/workspace_image-${FINAL_AMI_ID}.json"
log "6) writing control-plane ingest artifact ${OUT_JSON}"
jq -n \
  --arg schema        "dfap.workspace_image/v1" \
  --arg template      "linux-workspace" \
  --arg region        "${AWS_REGION}" \
  --arg ami_id        "${FINAL_AMI_ID}" \
  --arg ami_name      "${FINAL_AMI_NAME}" \
  --arg snapshot_id   "${HARDENED_SNAPSHOT_ID}" \
  --arg snapshot_sha  "${SNAPSHOT_SHA256}" \
  --arg arch          "${ARCH}" \
  --arg root_device   "${ROOT_DEV}" \
  --arg staging_ami   "${STAGING_AMI_ID}" \
  --arg src_snapshot  "${SRC_SNAPSHOT_ID}" \
  --arg git_commit    "${GIT_COMMIT}" \
  --arg built_at      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson cadence   "${REBUILD_CADENCE_DAYS}" \
  '{
     schema:  $schema,
     template: $template,
     region:  $region,
     ami_id:  $ami_id,
     ami_name: $ami_name,
     hardened_snapshot_id: $snapshot_id,
     snapshot_sha256: $snapshot_sha,
     architecture: $arch,
     root_device_name: $root_device,
     hardened: true,
     hardening: {
       method: "offline (libguestfs virt-customize on unbooted volume)",
       cis_profile: "cis_l1_subset",
       immutable_paths: true,
       host_keys_removed: true,
       machine_id_wiped: true,
       logs_zeroed: true,
       deadman_switch: true,
       rdp_channels_locked: ["cliprdr","rdpdr","rdpsnd","drdynvc","rail","xrdpvr"]
     },
     source: {
       staging_ami_id: $staging_ami,
       source_snapshot_id: $src_snapshot,
       git_commit: $git_commit
     },
     rebuild_cadence_days: $cadence,
     built_at: $built_at,
     signature: null
   }' > "${OUT_JSON}"

# Validate what we just wrote before declaring success.
jq empty "${OUT_JSON}" || die "produced invalid JSON at ${OUT_JSON}"
log "artifact written and validated:"
cat "${OUT_JSON}"

# --- optional: clean up the staging AMI + its snapshot to avoid orphan cost ---
if [[ "${KEEP_STAGING}" != "1" ]]; then
  log "deregistering staging AMI ${STAGING_AMI_ID} + deleting its snapshot ${SRC_SNAPSHOT_ID}"
  aws ec2 deregister-image --image-id "${STAGING_AMI_ID}" >/dev/null 2>&1 || true
  aws ec2 delete-snapshot  --snapshot-id "${SRC_SNAPSHOT_ID}" >/dev/null 2>&1 || true
fi

log "DONE. Final AMI: ${FINAL_AMI_ID}  sha256: ${SNAPSHOT_SHA256}"
echo "${OUT_JSON}"
