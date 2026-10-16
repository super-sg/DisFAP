# ---------------------------------------------------------------------------
# session-fleet :: launch-template.tf
#
# The declarative spec for a session VM (ADR-001: the launch template *is* the
# VM definition; the pool manager calls RunInstances against it — Terraform
# never launches session instances itself).
#
# Every security-relevant default is baked in here so that even a bare
# RunInstances with no overrides produces a correct, tagged, self-destructing,
# no-public-IP, IMDSv2-only, encrypted instance:
#   * tag-on-create      -> reaper + dead-man switch can always find it
#   * delete_on_term     -> no orphaned EBS after burn (ADR-004)
#   * IMDSv2 required     -> no SSRF-to-credentials
#   * no public IP        -> unreachable except via guacd over RDP
#   * encrypted root      -> CMK-wrapped at rest
# ---------------------------------------------------------------------------

# --- CMK for session EBS volumes -------------------------------------------
resource "aws_kms_key" "ebs" {
  description             = "${var.name_prefix} session EBS encryption CMK"
  deletion_window_in_days = 7
  enable_key_rotation     = true

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-ebs-cmk"
  })
}

resource "aws_kms_alias" "ebs" {
  name          = "alias/${var.name_prefix}-ebs"
  target_key_id = aws_kms_key.ebs.key_id
}

resource "aws_launch_template" "session" {
  name        = "${var.name_prefix}-session"
  description = "DisFAP session workspace VM. Launched per-session by the pool manager; never by Terraform."

  image_id      = var.session_ami_id
  instance_type = var.session_instance_type

  iam_instance_profile {
    arn = aws_iam_instance_profile.instance.arn
  }

  # --- No public IP + SG attachment on the interface ------------------------
  # The SG is set ON the network interface (NOT via top-level
  # vpc_security_group_ids) — specifying both would make RunInstances reject the
  # request ("network interfaces and instance-level security groups may not be
  # specified on the same request"). The default here is the session template;
  # in production the pool manager overrides it with the freshly-cloned
  # per-session SG at RunInstances time.
  network_interfaces {
    device_index                = 0
    associate_public_ip_address = false # reachable ONLY from guacd, over RDP
    delete_on_termination       = true
    security_groups             = [aws_security_group.session_template.id]
  }

  # --- IMDSv2 REQUIRED ------------------------------------------------------
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required" # reject IMDSv1 — token-only
    http_put_response_hop_limit = var.metadata_hop_limit
    instance_metadata_tags      = "enabled"  # guest can read its own dfap:* tags
  }

  # --- Root volume: encrypted, delete-on-terminate --------------------------
  block_device_mappings {
    device_name = "/dev/sda1" # Windows/AL2023 root; adjust per-image if needed
    ebs {
      volume_size           = var.session_root_volume_gb
      volume_type           = "gp3"
      encrypted             = true
      kms_key_id            = aws_kms_key.ebs.arn
      delete_on_termination = true # ADR-004: no residue survives the session
    }
  }

  # --- Tag-on-create: instances AND their volumes -------------------------
  # session_id / org_id / expires_at carry PLACEHOLDER values here; the pool
  # manager overrides them in the RunInstances TagSpecification per session.
  # dfap:managed=true is fixed and non-negotiable — it is the key every teardown
  # layer and IAM condition keys off of.
  tag_specifications {
    resource_type = "instance"
    tags = merge(local.common_tags, {
      Name              = "${var.name_prefix}-session"
      "dfap:role"       = "session"
      "dfap:session_id" = "PLACEHOLDER" # overridden per launch
      "dfap:org_id"     = "PLACEHOLDER" # overridden per launch
      "dfap:expires_at" = "PLACEHOLDER" # overridden per launch (RFC3339)
    })
  }

  tag_specifications {
    resource_type = "volume"
    tags = merge(local.common_tags, {
      Name        = "${var.name_prefix}-session-root"
      "dfap:role" = "session-volume"
    })
  }

  # The launch template resource itself.
  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-session-lt"
  })

  # New versions must be reviewed; require explicit default-version bumps rather
  # than silently repointing $Default on every apply.
  update_default_version = true

  lifecycle {
    create_before_destroy = true
  }
}
