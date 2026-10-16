# =============================================================================
# variables.pkr.hcl — inputs to the DisFAP Linux session-VM golden image build.
#
# Every value that changes between environments is a variable here. Nothing
# secret belongs in this file. Supply real values via an *.auto.pkrvars.hcl
# (git-ignored) or -var flags; see example.pkrvars.hcl for a starting point.
#
# HARD RULE: this template builds an *intermediate* ("staging") AMI. The AMI
# that a session pool is ever allowed to launch is produced only by the OFFLINE
# hardening stage (offline-harden/harden-offline.sh). The staging AMI must
# never be added to a launch template or booted on a session network. See
# README.md for why.
# =============================================================================

variable "region" {
  type        = string
  description = "AWS region to build in. Must match the region the offline-harden worker and the pool run in (AMIs are region-scoped)."
  default     = "us-east-1"
}

variable "instance_type" {
  type        = string
  description = "Builder instance type. t3.small is the brief's default; it only needs to run apt + xrdp install, not host a real session."
  default     = "t3.small"
}

# --- Isolated build network -------------------------------------------------
# The build runs in a dedicated, locked-down VPC/subnet — never a session
# subnet and never the default VPC. The subnet needs egress to the Ubuntu apt
# mirrors and to AWS APIs; with no public IP (recommended) that means either a
# NAT and SSM/S3/EC2messages VPC endpoints, or a NAT instance. See README.md.

variable "vpc_id" {
  type        = string
  description = "ID of the isolated build VPC. REQUIRED per-environment (no default — must be an intentional choice)."
}

variable "subnet_id" {
  type        = string
  description = "ID of the build subnet inside vpc_id. REQUIRED per-environment."
}

variable "associate_public_ip" {
  type        = bool
  description = "Whether to give the builder a public IP. Keep false and reach it over SSM Session Manager (ssh_interface below). Set true only for a throwaway public build subnet."
  default     = false
}

variable "ssh_interface" {
  type        = string
  description = "How Packer reaches the builder. 'session_manager' = no public IP, tunnels SSH over SSM (needs iam_instance_profile with SSM perms + the session-manager-plugin on the build host). Alternatives: 'private_ip', 'public_ip'."
  default     = "session_manager"

  validation {
    condition     = contains(["session_manager", "private_ip", "public_ip", "public_dns"], var.ssh_interface)
    error_message = "ssh_interface must be one of: session_manager, private_ip, public_ip, public_dns."
  }
}

variable "iam_instance_profile" {
  type        = string
  description = "Instance profile attached to the builder. REQUIRED when ssh_interface=session_manager (needs AmazonSSMManagedInstanceCore). Empty string when reaching the builder directly over SSH."
  default     = ""
}

variable "ssh_username" {
  type        = string
  description = "Login user on the Ubuntu base AMI. Canonical's images use 'ubuntu'."
  default     = "ubuntu"
}

# --- Base image selection ---------------------------------------------------
# We resolve the newest Ubuntu 24.04 LTS (Noble) server image at build time
# rather than pinning an AMI id (which is region-specific and rots). Pin the
# exact resolved id by recording it in the manifest instead (we do — see the
# amazon-ebs source's snapshot/AMI tags and the offline-harden JSON artifact).

variable "base_ami_owner" {
  type        = string
  description = "AMI owner account for the base image. 099720109477 = Canonical (official Ubuntu)."
  default     = "099720109477"
}

variable "base_ami_name_filter" {
  type        = string
  description = "Name glob selecting the base AMI. Default = Ubuntu 24.04 LTS (Noble), amd64, HVM, gp3-backed server image."
  default     = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"
}

variable "base_ami_architecture" {
  type        = string
  description = "CPU architecture of the base AMI. Must match instance_type (t3.small = x86_64)."
  default     = "x86_64"
}

# --- Output image identity --------------------------------------------------

variable "ami_name_prefix" {
  type        = string
  description = "Prefix for the staging AMI name. A UTC timestamp is appended for uniqueness."
  default     = "dfap-linux-workspace-staging"
}

variable "session_user" {
  type        = string
  description = "Name of the non-privileged desktop user the broker's RDP credential logs in as. Its password is LOCKED in the image and set per-session by the control plane via SSM at claim time — no credential is ever baked in."
  default     = "session"
}

# --- Encryption -------------------------------------------------------------

variable "encrypt_boot" {
  type        = bool
  description = "Encrypt the staging AMI's root snapshot. Keep true; the offline stage re-encrypts the final snapshot too."
  default     = true
}

variable "kms_key_id" {
  type        = string
  description = "KMS key (id/arn/alias) for the encrypted root snapshot. Empty string = the account's default EBS KMS key (aws/ebs)."
  default     = ""
}

# --- Provenance (stamped into tags + the offline JSON artifact) -------------

variable "git_commit" {
  type        = string
  description = "Git commit of this pipeline that produced the image, for audit provenance. Pass from CI (e.g. $(git rev-parse HEAD))."
  default     = "unknown"
}
