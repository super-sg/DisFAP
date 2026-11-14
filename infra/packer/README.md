# DisFAP hardened golden-image pipeline (`infra/packer/`)

Builds the **Linux session-VM golden image** that every DisFAP session boots
from. Two stages, on purpose:

```
Ubuntu 24.04 LTS base AMI (Canonical)
        │  Packer  (linux-workspace.pkr.hcl)  — ONLINE provisioning
        ▼
   STAGING AMI   (dfap:hardened=false — MUST NOT be launched into a session)
        │  offline-harden/harden-offline.sh   — OFFLINE, unbooted-volume hardening
        ▼
   FINAL AMI     (dfap:hardened=true)  +  workspace_image-<ami>.json
        │
        ▼
   control plane ingests JSON → workspace_images table → pool launches it
```

Two stages because **the immutable, last-mile hardening is applied to a cold,
unbooted volume** — the image's first boot on any network is already fully
hardened. See [`offline-harden/README.md`](offline-harden/README.md) for why
that is the product's differentiator; the short version is in
[`../../docs/architecture.md`](../../docs/architecture.md) ("Image pipeline").

> There is no AWS in the authoring environment, so nothing here was executed.
> The templates and scripts are written to be correct, complete, and
> `packer validate`-clean. Values that must be filled per environment are called
> out below and in `example.pkrvars.hcl`.

## Files

| Path | What |
|---|---|
| `linux-workspace.pkr.hcl` | Packer template: Ubuntu 24.04 base → xrdp + minimal XFCE + `session` user → provisioners → **staging** AMI. |
| `variables.pkr.hcl` | All per-environment inputs (region, instance type, build VPC/subnet, base-AMI filter, KMS, …). |
| `example.pkrvars.hcl` | Copy → `*.auto.pkrvars.hcl` (git-ignored) and fill in. |
| `provision/install-workspace.sh` | Installs xrdp/XFCE, creates the locked `session` user, **merges the RDP channel lockdown** into `xrdp.ini`, hardens `sesman.ini`. |
| `provision/harden.sh` | CIS-L1-style baseline + in-guest egress firewall + **installs the dead-man switch** + strips build tooling. |
| `provision/xrdp-lockdown.ini` | Source of truth for the disabled RDP virtual channels (isolation layer 3). |
| `systemd/dfap-deadman.service` · `.timer` | Runs the dead-man check once a minute. |
| `bin/dfap-deadman.sh` | The dead-man switch itself: self-terminate via IMDSv2 + `terminate-instances` if the broker heartbeat goes stale. |
| `offline-harden/harden-offline.sh` | The OFFLINE stage: snapshot → attach unbooted → `virt-customize` → re-snapshot → register final AMI → emit JSON. |
| `offline-harden/README.md` | Deep dive on the offline stage + the SHA-256 artifact. |

## How the image enforces the DisFAP guarantees

- **Isolation layer 3 — RDP channels disabled at the host.** `install-workspace.sh`
  sets `allow_channels=false` in `xrdp.ini` (the master kill switch) *and*
  individually disables `cliprdr` (clipboard), `rdpdr` (drives/printers/
  smartcards/COM/LPT), `rdpsnd` (audio out), `drdynvc` (the transport audio-in
  and video redirection ride on), `rail`, and `xrdpvr`. This survives a
  compromised **broker** that tries to turn channels back on — it is the backstop
  behind guacd's connection params (layer 1) and the broker instruction filter
  (layer 2). See [`../../docs/security.md`](../../docs/security.md).

- **Ephemerality + teardown layer 3 — the dead-man switch.** `harden.sh` installs
  a systemd timer that, once the VM is *claimed*, self-terminates the instance if
  the broker heartbeat file goes stale for 10 minutes. It is the only teardown
  layer that survives total control-plane loss. Its IAM role is scoped to
  terminate **only this instance**. Heartbeat contract below.

- **Auditability — pinned image identity.** The offline stage records the final
  AMI id and its snapshot SHA-256 as JSON for the `workspace_images` table, so
  every session references the exact hardened image it booted (ADR-004).

- **No baked-in credentials.** The `session` user ships with a **locked**
  password. The control plane sets a per-session password via SSM at claim time;
  nothing secret is ever in the image.

## Dead-man switch heartbeat contract

The switch is armed and fed through two files (also shipped in the image at
`/etc/dfap/heartbeat-contract.md`):

| File | Owner | Meaning |
|---|---|---|
| `/var/lib/dfap/armed` (persistent) | control plane, once at claim (SSM) | Existence arms the switch. Absent ⇒ disarmed (warm pool / unclaimed never self-terminates). |
| `/run/dfap/heartbeat` (tmpfs) | broker, every ~60 s (SSM `touch`) | Its mtime is the liveness signal. |

Rule: `reference = mtime(heartbeat) if present else mtime(armed)`; if
`now - reference > 600s`, terminate self. So a VM that is armed but never
heartbeated (broker died before its first touch) still dies after one window.

Tunables live in `/etc/dfap/deadman.env` (`DFAP_DEADMAN_THRESHOLD_SECS`,
`DFAP_DRY_RUN`, …).

## Build it

Prereqs on the build host: Packer ≥ 1.9, AWS credentials for the build account,
and (for `ssh_interface=session_manager`) the AWS `session-manager-plugin`.

```sh
cd infra/packer
cp example.pkrvars.hcl my.auto.pkrvars.hcl   # fill in vpc/subnet/profile
packer init .
packer validate -var-file=example.pkrvars.hcl .
packer build   -var="git_commit=$(git rev-parse HEAD)" .
# → writes manifest.json with the STAGING AMI id
```

Then, on the hardening worker (see `offline-harden/README.md`):

```sh
cd infra/packer/offline-harden
AWS_REGION=us-east-1 GIT_COMMIT="$(git rev-parse HEAD)" ./harden-offline.sh
# → registers the FINAL AMI and writes out/workspace_image-<ami>.json
```

### Per-environment values you must fill

| Where | Value | Notes |
|---|---|---|
| `*.pkrvars.hcl` | `vpc_id`, `subnet_id` | Isolated **build** VPC/subnet — never the default VPC, never a session subnet. |
| `*.pkrvars.hcl` | `iam_instance_profile` | Needs `AmazonSSMManagedInstanceCore` for SSM-reached builds. |
| `*.pkrvars.hcl` | `kms_key_id` | Empty ⇒ default `aws/ebs` key. |
| Packer env | `DFAP_VPC_CIDR` (in `harden.sh` provisioner) | Set to the **session** VPC CIDR to enable the in-guest egress firewall; empty leaves it staged-but-disabled (the per-session security group is the authoritative egress control either way). |
| offline stage | `AWS_REGION`, `KMS_KEY_ID`, `GIT_COMMIT` | See `offline-harden/README.md`. |
| Terraform (not here) | Instance-profile policy scoping `ec2:TerminateInstances` to *self* | The dead-man switch relies on it. The launch template also tags `dfap:session_id`, `dfap:expires_at`, `dfap:managed=true` (teardown layers 2 & 4). |
| Terraform (not here) | EC2 **interface VPC endpoint** in the session VPC | In the no-NAT Phase-0 topology the dead-man switch reaches `terminate-instances` through it; the in-guest firewall allows egress to the VPC CIDR for exactly this. |

## 7-day rebuild cadence

The image is **rebuilt from scratch every 7 days** and pool instances roll onto
the new AMI. This is deliberate:

1. **Patch currency without in-place mutation.** Session VMs are frozen at
   runtime (`harden.sh` disables `unattended-upgrades` and the apt timers, and
   the offline stage makes key files immutable), so the *only* way security
   patches reach the fleet is a fresh build. A weekly cadence bounds the
   unpatched window while keeping every running VM byte-identical to something
   that was reviewed and hash-pinned.
2. **Fresh provenance.** Each rebuild re-resolves the newest Canonical base AMI
   and records a new `workspace_images` row (new AMI id + snapshot SHA-256 +
   git commit). Old AMIs are retired once no running/pending session references
   them.
3. **Small, auditable diffs.** A weekly rebuild means image changes are reviewed
   in small increments (this pipeline is version-pinned and PR-reviewed, like the
   launch templates in ADR-001), not as a big-bang re-platform.

Automate it as a scheduled CI job that runs `packer build` → `harden-offline.sh`
→ posts the JSON artifact to the control plane's image-ingest endpoint.
