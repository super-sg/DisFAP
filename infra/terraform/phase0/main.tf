# ---------------------------------------------------------------------------
# phase0 :: main.tf
#
# The whole Phase-0 footprint:
#   1. session-fleet module in its cheapest mode (no NAT, cold launch).
#   2. one t4g.small control host running the docker-compose stack, with a
#      public Elastic IP and a 443-from-internet SG.
# ---------------------------------------------------------------------------

# --- The fleet --------------------------------------------------------------
module "fleet" {
  source = "../modules/session-fleet"

  name_prefix = var.name_prefix
  aws_region  = var.aws_region

  session_ami_id = var.session_ami_id

  # Phase-0 cost posture: no NAT of any kind, endpoints only.
  enable_nat_instance = false

  budget_limit_usd          = 50
  budget_notification_email = var.budget_notification_email

  # Egress allowlist left empty => session VMs are fully default-deny outbound.
  session_egress_allowlist = []
}

# --- Control-host AMI resolution -------------------------------------------
# Use the caller-provided AMI, else resolve the latest AL2023 arm64 from SSM.
data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-al2023-latest/al2023-ami-kernel-default-arm64"
}

locals {
  control_host_ami = var.control_host_ami_id != "" ? var.control_host_ami_id : data.aws_ssm_parameter.al2023_arm64.value
}

# --- Control-host SG: 443 from the internet, egress open --------------------
resource "aws_security_group" "control_host" {
  name        = "${var.name_prefix}-control-host"
  description = "Public web/broker entrypoint. 443 in, egress open (Phase-0)."
  vpc_id      = module.fleet.vpc_id

  ingress {
    description = "HTTPS (web app + client WSS tunnel)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.web_ingress_cidrs
  }

  # Phase-0 keeps control-host egress open: it pulls container images, talks to
  # AWS APIs, and (as guacd) opens RDP to session VMs. The tenant-isolation
  # guarantees live on the SESSION side, not here.
  egress {
    description = "All egress"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "${var.name_prefix}-control-host"
    "dfap:role" = "control-host"
  }
}

# --- Control-host IAM: SSM + pool-manager + recordings write ----------------
data "aws_iam_policy_document" "control_host_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "control_host" {
  name               = "${var.name_prefix}-control-host"
  assume_role_policy = data.aws_iam_policy_document.control_host_assume.json
}

# Manageable via Session Manager (no SSH port needed on the control host).
resource "aws_iam_role_policy_attachment" "control_host_ssm" {
  role       = aws_iam_role.control_host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# The control host IS the pool manager in Phase-0 — attach the module's policy.
resource "aws_iam_role_policy_attachment" "control_host_pool_manager" {
  role       = aws_iam_role.control_host.name
  policy_arn = module.fleet.pool_manager_policy_arn
}

# Write session recordings: PutObject into the bucket + use the recordings CMK.
data "aws_iam_policy_document" "control_host_recordings" {
  statement {
    sid       = "WriteRecordings"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${module.fleet.recordings_bucket_arn}/*"]
  }
  statement {
    sid       = "UseRecordingsKey"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey", "kms:Encrypt"]
    resources = [module.fleet.recordings_kms_key_arn]
  }
}

resource "aws_iam_role_policy" "control_host_recordings" {
  name   = "${var.name_prefix}-control-host-recordings"
  role   = aws_iam_role.control_host.id
  policy = data.aws_iam_policy_document.control_host_recordings.json
}

resource "aws_iam_instance_profile" "control_host" {
  name = "${var.name_prefix}-control-host"
  role = aws_iam_role.control_host.name
}

# --- The control host -------------------------------------------------------
resource "aws_instance" "control_host" {
  ami           = local.control_host_ami
  instance_type = var.control_host_instance_type

  # First public subnet; reachable from the internet via its EIP.
  subnet_id = module.fleet.public_subnet_ids[0]

  # Two SGs: its own public 443 SG, and the fleet's guacd_host SG so it is
  # allowed to open RDP into session VMs (session VMs trust the guacd SG).
  vpc_security_group_ids = [
    aws_security_group.control_host.id,
    module.fleet.guacd_host_sg_id,
  ]

  iam_instance_profile = aws_iam_instance_profile.control_host.name

  associate_public_ip_address = true

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required" # IMDSv2 only
  }

  root_block_device {
    volume_size           = 30
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }

  tags = {
    Name        = "${var.name_prefix}-control-host"
    "dfap:role" = "control-host"
  }
}

# --- Elastic IP for a stable public endpoint --------------------------------
resource "aws_eip" "control_host" {
  instance = aws_instance.control_host.id
  domain   = "vpc"

  tags = {
    Name = "${var.name_prefix}-control-host"
  }
}
