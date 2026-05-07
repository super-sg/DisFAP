# ============================================================================
# Terraform Module: VM Instance
# Creates ephemeral EC2 instances from pre-built AMIs for software sessions.
#
# Key Features:
#   - Dynamic AMI selection based on software type
#   - Session tagging for lifecycle management
#   - User data script for dynamic password injection
#   - EBS volumes with delete_on_termination
#   - Optional Spot Instance support for cost savings
# ============================================================================

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# ---------------------------------------------------------------------------
# Locals
# ---------------------------------------------------------------------------

locals {
  ttl_expiry = timeadd(timestamp(), "${var.ttl_minutes}m")

  instance_tags = merge(var.common_tags, {
    Name            = "${var.project_name}-session-${var.session_id}"
    SessionId       = var.session_id
    UserId          = var.user_id
    TTLExpiry       = local.ttl_expiry
    CreatedAt       = timestamp()
    SoftwareType    = var.software_type
    SessionStatus   = "provisioning"
    AutoDestroy     = "true"
  })
}

# ---------------------------------------------------------------------------
# User Data — Dynamic Password Injection
# Runs at first boot to set the session user's password dynamically.
# The password is injected by the Orchestrator and never stored on disk.
# ---------------------------------------------------------------------------

locals {
  windows_user_data = <<-EOF
    <powershell>
    # Set session user password (injected dynamically)
    $username = "${var.session_username}"
    $password = ConvertTo-SecureString "${var.session_password}" -AsPlainText -Force
    Set-LocalUser -Name $username -Password $password

    # Disable the Administrator account for security
    Disable-LocalUser -Name "Administrator"

    # Start CloudWatch Agent
    & "C:\Program Files\Amazon\AmazonCloudWatchAgent\amazon-cloudwatch-agent-ctl.ps1" `
      -a fetch-config -m ec2 -c ssm:${var.cloudwatch_config_param} -s

    # Signal that the VM is ready
    Write-Output "SESSION_READY" | Out-File -FilePath C:\session-ready.txt

    # Log session start
    $logEntry = @{
      event     = "session_started"
      sessionId = "${var.session_id}"
      userId    = "${var.user_id}"
      timestamp = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
    } | ConvertTo-Json
    Write-EventLog -LogName Application -Source "SessionManager" -EventId 1000 -Message $logEntry -ErrorAction SilentlyContinue
    </powershell>
  EOF

  linux_user_data = <<-EOF
    #!/bin/bash
    set -euo pipefail

    # Set session user password (injected dynamically)
    echo "${var.session_username}:${var.session_password}" | chpasswd

    # Set VNC password for session user
    su - ${var.session_username} -c "
      mkdir -p ~/.vnc
      echo '${var.session_password}' | vncpasswd -f > ~/.vnc/passwd
      chmod 600 ~/.vnc/passwd
    "

    # Start VNC server
    systemctl start vncserver@1.service

    # Signal that the VM is ready
    echo "SESSION_READY" > /tmp/session-ready.txt

    # Log session start
    logger -t session-manager "Session started: id=${var.session_id} user=${var.user_id}"
  EOF

  user_data = var.os_type == "windows" ? local.windows_user_data : local.linux_user_data
}

# ---------------------------------------------------------------------------
# EC2 Instance — On-Demand
# ---------------------------------------------------------------------------

resource "aws_instance" "session_vm" {
  count = var.use_spot_instances ? 0 : 1

  ami                    = var.ami_id
  instance_type          = var.instance_type
  subnet_id              = var.subnet_id
  vpc_security_group_ids = var.security_group_ids
  iam_instance_profile   = var.instance_profile_name
  key_name               = var.key_pair_name != "" ? var.key_pair_name : null

  # User data for dynamic configuration
  user_data = base64encode(local.user_data)

  # EBS root volume — encrypted, delete on termination
  root_block_device {
    volume_size           = var.root_volume_size
    volume_type           = "gp3"
    encrypted             = true
    kms_key_id            = var.kms_key_id != "" ? var.kms_key_id : null
    delete_on_termination = true

    tags = merge(local.instance_tags, {
      Name = "${var.project_name}-session-${var.session_id}-root"
    })
  }

  # Metadata options (IMDSv2 required for security)
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"  # Enforce IMDSv2
    http_put_response_hop_limit = 1
  }

  # Monitoring
  monitoring = var.enable_detailed_monitoring

  # Disable API termination protection (ephemeral VM — must be destroyable)
  disable_api_termination = false

  # Instance-initiated shutdown behavior
  instance_initiated_shutdown_behavior = "terminate"

  tags = local.instance_tags

  lifecycle {
    # Prevent accidental updates that would recreate the instance mid-session
    ignore_changes = [ami, user_data]
  }
}

# ---------------------------------------------------------------------------
# Spot Instance (Cost Optimization)
# ---------------------------------------------------------------------------

resource "aws_spot_instance_request" "session_vm_spot" {
  count = var.use_spot_instances ? 1 : 0

  ami                    = var.ami_id
  instance_type          = var.instance_type
  subnet_id              = var.subnet_id
  vpc_security_group_ids = var.security_group_ids
  iam_instance_profile   = var.instance_profile_name

  # Spot-specific settings
  spot_type                      = "one-time"
  instance_interruption_behavior = "terminate"
  wait_for_fulfillment           = true

  # User data
  user_data = base64encode(local.user_data)

  # EBS
  root_block_device {
    volume_size           = var.root_volume_size
    volume_type           = "gp3"
    encrypted             = true
    kms_key_id            = var.kms_key_id != "" ? var.kms_key_id : null
    delete_on_termination = true
  }

  # Metadata
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  monitoring                           = var.enable_detailed_monitoring
  disable_api_termination              = false
  instance_initiated_shutdown_behavior = "terminate"

  tags = local.instance_tags
}
