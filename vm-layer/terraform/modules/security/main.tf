# ============================================================================
# Terraform Module: Security
# Creates IAM roles, instance profiles, and KMS keys for the VM Layer.
# Follows least-privilege principle — VMs get minimal permissions.
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
# Data Sources
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# ---------------------------------------------------------------------------
# IAM Role: Session VM (Minimal — CloudWatch only)
# ---------------------------------------------------------------------------

resource "aws_iam_role" "session_vm" {
  name_prefix = "${var.project_name}-session-vm-"
  description = "Minimal IAM role for session VMs. Only allows CloudWatch metrics/logs."

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-session-vm-role"
  })
}

# CloudWatch permissions for session VM
resource "aws_iam_role_policy" "session_vm_cloudwatch" {
  name_prefix = "cloudwatch-"
  role        = aws_iam_role.session_vm.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "cloudwatch:PutMetricData",
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameter"
        ]
        Resource = "arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/*"
      }
    ]
  })
}

# Instance profile for session VMs
resource "aws_iam_instance_profile" "session_vm" {
  name_prefix = "${var.project_name}-session-vm-"
  role        = aws_iam_role.session_vm.name

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-session-vm-profile"
  })
}

# ---------------------------------------------------------------------------
# IAM Role: VM Manager Service
# ---------------------------------------------------------------------------

resource "aws_iam_role" "vm_manager" {
  name_prefix = "${var.project_name}-vm-manager-"
  description = "IAM role for the VM Manager service. Manages EC2 lifecycle."

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-vm-manager-role"
  })
}

# EC2 management permissions for VM Manager
resource "aws_iam_role_policy" "vm_manager_ec2" {
  name_prefix = "ec2-management-"
  role        = aws_iam_role.vm_manager.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ec2:RunInstances",
          "ec2:TerminateInstances",
          "ec2:StopInstances",
          "ec2:StartInstances",
          "ec2:DescribeInstances",
          "ec2:DescribeInstanceStatus",
          "ec2:CreateTags",
          "ec2:DeleteTags",
          "ec2:DescribeImages",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeSubnets",
          "ec2:DescribeVpcs"
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "ec2:ResourceTag/Project" = var.project_name
          }
        }
      },
      {
        # Allow RunInstances without tag condition (tags applied after launch)
        Effect = "Allow"
        Action = [
          "ec2:RunInstances"
        ]
        Resource = [
          "arn:aws:ec2:*:*:instance/*",
          "arn:aws:ec2:*:*:volume/*",
          "arn:aws:ec2:*:*:network-interface/*",
          "arn:aws:ec2:*:*:security-group/*",
          "arn:aws:ec2:*:*:subnet/*",
          "arn:aws:ec2:*:*:image/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "ec2:RequestSpotInstances",
          "ec2:CancelSpotInstanceRequests",
          "ec2:DescribeSpotInstanceRequests"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = "iam:PassRole"
        Resource = aws_iam_role.session_vm.arn
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# KMS Key: EBS Volume Encryption
# ---------------------------------------------------------------------------

resource "aws_kms_key" "ebs_encryption" {
  description             = "KMS key for encrypting session VM EBS volumes"
  deletion_window_in_days = 7
  enable_key_rotation     = true

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "EnableRootAccountAccess"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        Sid    = "AllowEC2UseKey"
        Effect = "Allow"
        Principal = {
          AWS = [
            aws_iam_role.session_vm.arn,
            aws_iam_role.vm_manager.arn
          ]
        }
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey",
          "kms:CreateGrant"
        ]
        Resource = "*"
      }
    ]
  })

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-ebs-kms"
  })
}

resource "aws_kms_alias" "ebs_encryption" {
  name          = "alias/${var.project_name}-ebs"
  target_key_id = aws_kms_key.ebs_encryption.key_id
}
