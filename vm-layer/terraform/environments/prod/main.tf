# ============================================================================
# Terraform Environment: Prod
# Production configuration with GPU instances, multi-AZ, enhanced monitoring.
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

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = "prod"
      ManagedBy   = "terraform"
    }
  }
}

# ---------------------------------------------------------------------------
# Modules
# ---------------------------------------------------------------------------

module "networking" {
  source = "../../modules/networking"

  project_name             = var.project_name
  vpc_cidr                 = var.vpc_cidr
  public_subnet_cidr       = var.public_subnet_cidr
  private_subnet_cidr      = var.private_subnet_cidr
  availability_zone        = "${var.aws_region}a"
  orchestrator_cidr_blocks = var.orchestrator_cidr_blocks
  enable_flow_logs         = true
  flow_log_role_arn        = var.flow_log_role_arn
  flow_log_group_arn       = var.flow_log_group_arn

  common_tags = local.common_tags
}

module "security" {
  source = "../../modules/security"

  project_name = var.project_name
  common_tags  = local.common_tags
}

locals {
  common_tags = {
    Project     = var.project_name
    Environment = "prod"
    ManagedBy   = "terraform"
  }
}
