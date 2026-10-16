# =============================================================================
# linux-workspace.pkr.hcl — DisFAP Linux session-VM golden image (staging build)
#
# Builds an Ubuntu 24.04 LTS image running xrdp + a minimal XFCE desktop for a
# single non-privileged 'session' user, with all RDP redirection channels
# disabled AT THE HOST (isolation layer 3, docs/security.md). It also bakes in
# the CIS-L1-style baseline and the dead-man switch (teardown layer 3,
# docs/architecture.md).
#
# This produces the *staging* AMI only. The final, pool-launchable AMI is
# emitted by offline-harden/harden-offline.sh, which mounts this build's root
# volume WITHOUT booting it and applies the immutable/last-mile hardening. That
# is the whole point: the image never boots unhardened on a network.
#
# Run:
#   packer init  .
#   packer validate -var-file=example.pkrvars.hcl .
#   packer build   -var-file=example.pkrvars.hcl .
#
# There is NO AWS available in the authoring environment; this file is written
# to be correct and complete, not executed here.
# =============================================================================

packer {
  required_version = ">= 1.9.0"

  required_plugins {
    amazon = {
      source  = "github.com/hashicorp/amazon"
      version = ">= 1.3.0"
    }
  }
}

# -----------------------------------------------------------------------------
# Derived values. `local.timestamp` gives every build a unique, sortable name.
# -----------------------------------------------------------------------------
locals {
  # e.g. 20260722T041500Z — sortable, filename-safe, unambiguous UTC.
  timestamp = formatdate("YYYYMMDD'T'hhmmss'Z'", timestamp())

  ami_name = "${var.ami_name_prefix}-${local.timestamp}"

  # Tags applied to the AMI, its snapshot, and (some of) the build instance so
  # cost/audit tooling can always trace an image back to its source and commit.
  # dfap:hardened=false is LOAD-BEARING: the pool manager must refuse to launch
  # any AMI that is not dfap:hardened=true (only the offline stage sets that).
  common_tags = {
    "dfap:template"    = "linux-workspace"
    "dfap:stage"       = "staging"
    "dfap:hardened"    = "false"
    "dfap:managed"     = "true"
    "dfap:git_commit"  = var.git_commit
    "dfap:base_owner"  = var.base_ami_owner
    "dfap:build_time"  = local.timestamp
    "Name"             = local.ami_name
  }
}

# -----------------------------------------------------------------------------
# Source: build from the newest official Ubuntu 24.04 LTS base AMI, in the
# isolated build VPC, reached over SSM (no public IP by default).
# -----------------------------------------------------------------------------
source "amazon-ebs" "linux_workspace" {
  region        = var.region
  instance_type = var.instance_type
  ami_name      = local.ami_name
  ami_description = "DisFAP Linux session workspace (STAGING — not for session use; must pass offline hardening). Built from ${var.base_ami_name_filter}."

  # --- base image (resolved fresh each build; exact id recorded in tags) -----
  source_ami_filter {
    filters = {
      name                = var.base_ami_name_filter
      root-device-type    = "ebs"
      virtualization-type = "hvm"
      architecture        = var.base_ami_architecture
    }
    owners      = [var.base_ami_owner]
    most_recent = true
  }

  # --- isolated build network ------------------------------------------------
  vpc_id                      = var.vpc_id
  subnet_id                   = var.subnet_id
  associate_public_ip_address = var.associate_public_ip
  ssh_username                = var.ssh_username
  ssh_interface               = var.ssh_interface
  # Required when ssh_interface = session_manager; harmless otherwise. Packer
  # only sets a profile when the string is non-empty.
  iam_instance_profile = var.iam_instance_profile

  # --- force IMDSv2 on the builder (and, by inheritance, good hygiene) -------
  # The dead-man switch relies on IMDSv2; requiring it here also means the
  # build never depends on the weaker IMDSv1. hop limit 2 lets the SSM agent
  # and our tooling reach IMDS from within the default network namespace.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
    instance_metadata_tags      = "enabled"
  }

  # --- root volume: encrypted, gp3, right-sized ------------------------------
  launch_block_device_mappings {
    device_name           = "/dev/sda1" # Ubuntu HVM root device
    volume_type           = "gp3"
    volume_size           = 20
    delete_on_termination = true
    encrypted             = var.encrypt_boot
    # Empty kms_key_id => account default aws/ebs key. Packer treats "" as unset.
    kms_key_id = var.kms_key_id
  }

  # Encrypt the resulting AMI snapshot too (the artifact that outlives the build).
  encrypt_boot = var.encrypt_boot
  kms_key_id   = var.kms_key_id

  # --- tags ------------------------------------------------------------------
  tags            = local.common_tags # applied to the AMI
  snapshot_tags   = local.common_tags # applied to the AMI's root snapshot
  run_tags        = merge(local.common_tags, { "Name" = "packer-build-${local.ami_name}" })
  run_volume_tags = merge(local.common_tags, { "Name" = "packer-build-${local.ami_name}" })

  # Clean SSH: use a throwaway keypair generated by Packer; nothing persists.
  temporary_key_pair_type = "ed25519"
}

# -----------------------------------------------------------------------------
# Build: stage assets, then provision. Order matters:
#   1. upload the DisFAP asset tree (units, deadman script, xrdp lockdown)
#   2. install-workspace.sh  — xrdp + XFCE + 'session' user + channel lockdown
#   3. harden.sh             — CIS-L1 baseline + dead-man switch + firewall +
#                              strip build tooling (LAST, so earlier steps can
#                              still compile/download if they need to)
#   4. cleanup               — apt cache, cloud-init state, staging dir
# -----------------------------------------------------------------------------
build {
  name    = "dfap-linux-workspace"
  sources = ["source.amazon-ebs.linux_workspace"]

  # 0) Ensure the staging root exists before any upload. A single-file upload
  #    (xrdp-lockdown.ini) does NOT create its parent dir, so make it explicitly.
  provisioner "shell" {
    inline = ["mkdir -p /tmp/dfap-stage/bin /tmp/dfap-stage/systemd /tmp/dfap-stage/provision"]
  }

  # 1) Stage the asset tree into a writable dir owned by the ssh user. The
  #    provisioner scripts (run via sudo) move each file into place with the
  #    correct owner/mode. Trailing slashes copy directory *contents*.
  provisioner "file" {
    source      = "bin/"
    destination = "/tmp/dfap-stage/bin/"
  }
  provisioner "file" {
    source      = "systemd/"
    destination = "/tmp/dfap-stage/systemd/"
  }
  provisioner "file" {
    source      = "provision/xrdp-lockdown.ini"
    destination = "/tmp/dfap-stage/xrdp-lockdown.ini"
  }
  # Guest credential-provisioning scripts (audit C3 / M8). Directory upload
  # creates the destination tree.
  provisioner "file" {
    source      = "provision/guest/"
    destination = "/tmp/dfap-stage/provision/guest/"
  }

  # 2) Install the workspace (xrdp + XFCE + session user + host channel lockdown).
  provisioner "shell" {
    script          = "provision/install-workspace.sh"
    execute_command = "chmod +x '{{ .Path }}'; sudo -E bash '{{ .Path }}'"
    environment_vars = [
      "DFAP_STAGE=/tmp/dfap-stage",
      "DFAP_SESSION_USER=${var.session_user}",
      "DEBIAN_FRONTEND=noninteractive",
    ]
    # xrdp/XFCE pull a lot of packages on a slow mirror; give it room.
    timeout = "30m"
  }

  # 3) CIS-L1 baseline + dead-man switch + firewall + strip build tooling.
  #    DFAP_VPC_CIDR is optional: when a real CIDR is passed the in-guest
  #    nftables egress policy is enabled; otherwise it is staged-but-disabled
  #    with a loud warning (the authoritative egress control is the per-session
  #    security group — this firewall is defence-in-depth). See harden.sh.
  provisioner "shell" {
    script          = "provision/harden.sh"
    execute_command = "chmod +x '{{ .Path }}'; sudo -E bash '{{ .Path }}'"
    environment_vars = [
      "DFAP_STAGE=/tmp/dfap-stage",
      "DFAP_SESSION_USER=${var.session_user}",
      "DFAP_VPC_CIDR=", # set per-environment to enable in-guest egress firewall
      "DEBIAN_FRONTEND=noninteractive",
    ]
    timeout = "20m"
  }

  # 4) Light cleanup. The OFFLINE stage does the authoritative log/host-key wipe
  #    on the unbooted volume; this just avoids shipping obvious build litter.
  provisioner "shell" {
    inline = [
      "sudo rm -rf /tmp/dfap-stage",
      "sudo apt-get clean",
      "sudo rm -rf /var/lib/apt/lists/*",
      # Let cloud-init re-run cleanly on the pool VM's first boot.
      "sudo cloud-init clean --logs || true",
    ]
    execute_command = "chmod +x '{{ .Path }}'; sudo -E bash '{{ .Path }}'"
  }

  # Emit a manifest so the offline hardening stage can find this build's AMI id
  # without a human copy-pasting it. offline-harden/harden-offline.sh reads
  # manifest.json by default.
  post-processor "manifest" {
    output     = "manifest.json"
    strip_path = true
    custom_data = {
      template     = "linux-workspace"
      stage        = "staging"
      git_commit   = var.git_commit
      session_user = var.session_user
      region       = var.region
    }
  }
}
