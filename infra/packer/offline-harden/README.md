# Offline hardening stage

This stage converts the **staging AMI** (produced by `../linux-workspace.pkr.hcl`)
into the **final, pool-launchable AMI** — and it does so while the image is a
*cold, unbooted EBS volume*, never a running machine on a network.

It is DisFAP's differentiator. Two properties fall out of doing it offline:

1. **The image never boots unhardened on a network.** A conventional pipeline
   boots the VM, runs remediation over SSH, then snapshots. During that window
   the machine is reachable and only partially hardened — exactly the state an
   attacker (or a bug in the remediation) wants. Here, the last-mile hardening
   is applied by `libguestfs`/`virt-customize` to the filesystem *mounted inside
   an isolated appliance*. The guest OS on the volume executes zero instructions
   until it is already fully hardened. Its **first boot on any network is the
   hardened state**.

2. **Some hardening is only safe when the target isn't running.** You cannot
   sanely set `chattr +i` on `/etc/shadow`, wipe `/etc/machine-id`, or delete
   the SSH host keys of the very system you are logged into. Offline, these are
   trivial and deterministic.

## What it applies (on the unbooted volume)

- `chattr +i` on security-critical files (`/etc/passwd`, `/etc/shadow`,
  `sshd_config`, the sysctl/audit/dead-man drop-ins, the xrdp lockdown, …) so
  even root-in-guest cannot quietly rewrite them. We do **not** make `/etc`
  itself immutable, nor `/etc/machine-id` — `systemd` must regenerate the
  machine-id on first boot.
- Remove SSH host keys (regenerated fresh per instance; also, sshd is disabled).
- Wipe `/etc/machine-id` and the D-Bus machine-id (unique per booted instance).
- Zero all logs and remove the journal, audit logs, and cloud-init seed/state.
- Clear shell histories and any stray `authorized_keys`.

## What it records (the auditor's artifact)

`out/workspace_image-<ami>.json`, schema `dfap.workspace_image/v1`:

```json
{
  "ami_id": "ami-…",
  "region": "us-east-1",
  "hardened_snapshot_id": "snap-…",
  "snapshot_sha256": "…64 hex…",
  "hardened": true,
  "hardening": { "method": "offline (libguestfs …)", "…": "…" },
  "source": { "staging_ami_id": "ami-…", "git_commit": "…" },
  "rebuild_cadence_days": 7
}
```

The control plane ingests this into the `workspace_images` table (AMI id +
snapshot SHA-256 per build, see `docs/architecture.md`). Every `sessions` row
then references the exact hardened image it booted — so *"what could this
session access?"* has a static, pinned answer (ADR-004).

## The SHA-256 and reproducible hashing

`snapshot_sha256` is `sha256sum` of the **raw hardened root device**, computed
after `virt-customize` and before detach/snapshot — so it is the exact content
the final snapshot captures. It proves *this AMI's snapshot has not been altered
since registration*.

A block-level hash includes filesystem metadata and unallocated regions, so it
is a fingerprint of **this build**, not a byte-identical value across
independent builds. If you need cross-build reproducible attestation, hash a
sorted manifest of per-file checksums instead — for example, inside the same
`virt-customize` step:

```sh
# reproducible file-content manifest (illustrative)
find / -xdev -type f -print0 | sort -z \
  | xargs -0 sha256sum > /var/lib/dfap/image-manifest.txt
# then sha256sum that manifest as the reproducible image id
```

Both approaches are legitimate; pick per your attestation requirement. The block
hash is the default because it directly matches "the snapshot as registered".

## Running it

On the **hardening worker** (a dedicated EC2 instance with `libguestfs-tools`,
`qemu-utils`, `awscli` v2, `jq`, and the IAM role listed in the script header):

```sh
# option A: let it read the staging AMI id from the Packer manifest
AWS_REGION=us-east-1 GIT_COMMIT="$(git rev-parse HEAD)" \
  ./harden-offline.sh            # PACKER_MANIFEST defaults to ../manifest.json

# option B: pass the staging AMI id explicitly (manifest not on this host)
AWS_REGION=us-east-1 STAGING_AMI_ID=ami-0abc… KMS_KEY_ID=alias/dfap-ebs \
  GIT_COMMIT="$(git rev-parse HEAD)" ./harden-offline.sh
```

### Per-environment values to fill

| Variable | Meaning |
|---|---|
| `AWS_REGION` | Region of the staging AMI **and** the output AMI (AMIs are region-scoped). |
| `STAGING_AMI_ID` | Staging AMI from Packer (or read from `PACKER_MANIFEST`). |
| `KMS_KEY_ID` | KMS key for the final encrypted snapshot/AMI (empty = `aws/ebs`). |
| `AMI_NAME_PREFIX` | Name prefix for the final AMI. |
| `GIT_COMMIT` | Provenance stamp (pass from CI). |
| `KEEP_STAGING` | `1` to keep the staging AMI/snapshot; default deregisters + deletes them to avoid orphan cost. |
| `OUTPUT_DIR` | Where the JSON artifact is written (default `./out`). |

The worker's IAM role must allow the EC2/EBS actions listed in the script header
and (if `KMS_KEY_ID` is set) `kms:*` grants on that key for EBS.

## Why this is the differentiator, restated for a security questionnaire

> "Golden images are hardened on an **offline, unbooted volume**. The image's
> first network boot is already in its fully hardened, immutable state; there is
> no window in which a partially hardened image is reachable. Each image is
> pinned by a content SHA-256 recorded at registration and referenced by every
> session that boots it."
