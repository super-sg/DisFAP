# =============================================================================
# example.pkrvars.hcl — copy to a real *.auto.pkrvars.hcl (git-ignored) and
# fill in the per-environment values, or pass with `-var-file=`.
#
#   cp example.pkrvars.hcl my.auto.pkrvars.hcl   # *.auto.pkrvars.hcl is ignored
#   packer validate -var-file=example.pkrvars.hcl .
#
# NOTHING here is secret. vpc_id/subnet_id/iam_instance_profile are the only
# strictly required values (they have no safe defaults).
# =============================================================================

region        = "us-east-1"
instance_type = "t3.small"

# --- REQUIRED: isolated build network ---------------------------------------
vpc_id    = "vpc-REPLACE_ME" # dedicated build VPC (never the default VPC)
subnet_id = "subnet-REPLACE_ME" # build subnet inside vpc_id

# Reach the builder over SSM (no public IP). Requires this profile to carry
# AmazonSSMManagedInstanceCore and the build host to have session-manager-plugin.
ssh_interface        = "session_manager"
iam_instance_profile = "dfap-packer-build" # REPLACE with your instance profile
associate_public_ip  = false

# --- base image (defaults already select Ubuntu 24.04 LTS amd64) ------------
# base_ami_owner       = "099720109477"
# base_ami_name_filter = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"

# --- output image identity + encryption -------------------------------------
ami_name_prefix = "dfap-linux-workspace-staging"
session_user    = "session"
encrypt_boot    = true
kms_key_id      = "" # "" = default aws/ebs key; else alias/arn/id

# --- provenance (pass from CI) ----------------------------------------------
# git_commit = "set-me-in-CI"
