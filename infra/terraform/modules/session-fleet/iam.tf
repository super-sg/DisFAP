# ---------------------------------------------------------------------------
# session-fleet :: iam.tf
#
# Two principals plus the dead-man switch:
#   * instance role   — attached to every session VM. Enough to be managed
#                       (SSM), ship logs, and TERMINATE ITSELF. Nothing else.
#   * pool-manager     — the control-plane principal that launches/terminates
#                       session VMs and clones per-session SGs. Least privilege,
#                       scoped by the dfap:managed tag wherever the API supports
#                       a resource/request tag condition.
#
# The self-terminate grant is the guest-side layer of the five-layer teardown
# (architecture.md): if the control plane never issues a terminate, the VM kills
# itself. IAM cannot express "this exact instance id" (the id is unknown at
# policy-authoring time), so we gate on aws:ResourceTag/dfap:managed=true and
# accept a bounded residual: a compromised guest could terminate a *sibling*
# managed VM but nothing unmanaged. That residual is further contained by ADR-004
# (every VM is single-session and about to die anyway) and by the per-session
# SGs that block lateral movement in the first place.
# ---------------------------------------------------------------------------

# ===========================================================================
# Session-VM INSTANCE role
# ===========================================================================

data "aws_iam_policy_document" "instance_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "${var.name_prefix}-session-instance"
  assume_role_policy = data.aws_iam_policy_document.instance_assume.json
  tags               = local.common_tags
}

# Managed presence for Session Manager (our SSH replacement) — no inbound port,
# no key pairs. This is what makes the no-NAT + no-public-IP posture operable.
resource "aws_iam_role_policy_attachment" "instance_ssm_core" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Dead-man switch: allow the instance to terminate a dfap:managed instance
# (in practice, itself — see header). Scoped hard by the managed tag.
data "aws_iam_policy_document" "instance_self_terminate" {
  statement {
    sid       = "SelfTerminateManagedOnly"
    effect    = "Allow"
    actions   = ["ec2:TerminateInstances"]
    resources = ["arn:aws:ec2:${local.region}:${local.account_id}:instance/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/dfap:managed"
      values   = ["true"]
    }
  }

  # DescribeInstances has no resource-level scoping in EC2; the guest needs it
  # only to confirm its own state before self-terminating.
  statement {
    sid       = "DescribeSelf"
    effect    = "Allow"
    actions   = ["ec2:DescribeInstances", "ec2:DescribeTags"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "instance_self_terminate" {
  name   = "${var.name_prefix}-self-terminate"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.instance_self_terminate.json
}

# Let the agent ship logs to CloudWatch (via the logs interface endpoint).
data "aws_iam_policy_document" "instance_logs" {
  statement {
    sid    = "ShipLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = ["arn:aws:logs:${local.region}:${local.account_id}:log-group:/dfap/*"]
  }
}

resource "aws_iam_role_policy" "instance_logs" {
  name   = "${var.name_prefix}-instance-logs"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.instance_logs.json
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.name_prefix}-session-instance"
  role = aws_iam_role.instance.name
  tags = local.common_tags
}

# ===========================================================================
# POOL-MANAGER role + policy
# ===========================================================================
# Exposed as BOTH a role (assumable by EC2, e.g. the control host) and a managed
# policy (so a caller can attach it to an existing role instead). phase0 attaches
# the policy to the control-host role.

data "aws_iam_policy_document" "pool_manager_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "pool_manager" {
  name               = "${var.name_prefix}-pool-manager"
  assume_role_policy = data.aws_iam_policy_document.pool_manager_assume.json
  tags               = local.common_tags
}

data "aws_iam_policy_document" "pool_manager" {
  # --- Launch session VMs from the launch template -------------------------
  # RunInstances touches many resource types; EC2 does not support tagging
  # conditions on all of them at RunInstances time, so we scope by region/account
  # ARNs and rely on tag-on-create (launch template) for the managed marker.
  statement {
    sid    = "RunInstances"
    effect = "Allow"
    actions = ["ec2:RunInstances"]
    resources = [
      "arn:aws:ec2:${local.region}:${local.account_id}:instance/*",
      "arn:aws:ec2:${local.region}:${local.account_id}:volume/*",
      "arn:aws:ec2:${local.region}:${local.account_id}:network-interface/*",
      "arn:aws:ec2:${local.region}:${local.account_id}:security-group/*",
      "arn:aws:ec2:${local.region}:${local.account_id}:launch-template/*",
      "arn:aws:ec2:${local.region}:${local.account_id}:subnet/*",
      "arn:aws:ec2:${local.region}:${local.account_id}:key-pair/*",
      "arn:aws:ec2:${local.region}::image/*",
    ]
  }

  # --- Terminate/Stop/Start ONLY dfap:managed instances --------------------
  statement {
    sid       = "ManageManagedInstances"
    effect    = "Allow"
    actions   = ["ec2:TerminateInstances", "ec2:StopInstances", "ec2:StartInstances"]
    resources = ["arn:aws:ec2:${local.region}:${local.account_id}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/dfap:managed"
      values   = ["true"]
    }
  }

  # --- Read fleet state -----------------------------------------------------
  statement {
    sid    = "DescribeFleet"
    effect = "Allow"
    actions = [
      "ec2:DescribeInstances",
      "ec2:DescribeInstanceStatus",
      "ec2:DescribeTags",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeSubnets",
      "ec2:DescribeLaunchTemplates",
      "ec2:DescribeLaunchTemplateVersions",
    ]
    resources = ["*"] # these Describe* actions have no resource-level scoping
  }

  # --- Tag-on-create only (the request must carry dfap:managed=true) --------
  statement {
    sid       = "CreateTagsOnLaunch"
    effect    = "Allow"
    actions   = ["ec2:CreateTags"]
    resources = ["arn:aws:ec2:${local.region}:${local.account_id}:*/*"]
    condition {
      # Only permitted as part of a create call, never to retag existing infra.
      test     = "StringEquals"
      variable = "ec2:CreateAction"
      values   = ["RunInstances", "CreateSecurityGroup"]
    }
  }

  # --- Clone/destroy per-session security groups ---------------------------
  statement {
    sid    = "ManageSessionSecurityGroups"
    effect = "Allow"
    actions = [
      "ec2:CreateSecurityGroup",
      "ec2:DeleteSecurityGroup",
      "ec2:AuthorizeSecurityGroupIngress",
      "ec2:RevokeSecurityGroupIngress",
      "ec2:AuthorizeSecurityGroupEgress",
      "ec2:RevokeSecurityGroupEgress",
    ]
    resources = [
      "arn:aws:ec2:${local.region}:${local.account_id}:security-group/*",
      "arn:aws:ec2:${local.region}:${local.account_id}:vpc/*",
    ]
  }

  # --- PassRole: hand the instance profile to launched VMs -----------------
  # Scoped to exactly the session instance role, and only when passing to EC2.
  statement {
    sid       = "PassInstanceRole"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.instance.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_policy" "pool_manager" {
  name        = "${var.name_prefix}-pool-manager"
  description = "Least-privilege control-plane rights to launch/terminate session VMs and clone per-session SGs."
  policy      = data.aws_iam_policy_document.pool_manager.json
  tags        = local.common_tags
}

resource "aws_iam_role_policy_attachment" "pool_manager" {
  role       = aws_iam_role.pool_manager.name
  policy_arn = aws_iam_policy.pool_manager.arn
}
