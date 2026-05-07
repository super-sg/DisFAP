# ============================================================================
# Terraform Environment: Prod — Variables
# ============================================================================

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "project_name" {
  type    = string
  default = "software-sharing"
}

variable "vpc_cidr" {
  type    = string
  default = "10.1.0.0/16"
}

variable "public_subnet_cidr" {
  type    = string
  default = "10.1.1.0/24"
}

variable "private_subnet_cidr" {
  type    = string
  default = "10.1.2.0/24"
}

variable "orchestrator_cidr_blocks" {
  type    = list(string)
  default = ["10.1.0.0/16"]
}

variable "flow_log_role_arn" {
  type    = string
  default = ""
}

variable "flow_log_group_arn" {
  type    = string
  default = ""
}
