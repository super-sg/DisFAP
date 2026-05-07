# ============================================================================
# Terraform Environment: Dev — Variables
# ============================================================================

variable "aws_region" {
  type        = string
  description = "AWS region for deployment."
  default     = "us-east-1"
}

variable "project_name" {
  type        = string
  description = "Project name for resource naming."
  default     = "software-sharing"
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "public_subnet_cidr" {
  type    = string
  default = "10.0.1.0/24"
}

variable "private_subnet_cidr" {
  type    = string
  default = "10.0.2.0/24"
}

variable "orchestrator_cidr_blocks" {
  type    = list(string)
  default = ["10.0.0.0/16"]
}
