# ============================================================================
# Terraform Module: Networking — Variables
# ============================================================================

variable "project_name" {
  type        = string
  description = "Project name for resource naming and tagging."
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR block for the VPC."
  default     = "10.0.0.0/16"
}

variable "public_subnet_cidr" {
  type        = string
  description = "CIDR block for the public subnet."
  default     = "10.0.1.0/24"
}

variable "private_subnet_cidr" {
  type        = string
  description = "CIDR block for the private subnet (session VMs)."
  default     = "10.0.2.0/24"
}

variable "availability_zone" {
  type        = string
  description = "AWS availability zone for subnet placement."
  default     = "us-east-1a"
}

variable "orchestrator_cidr_blocks" {
  type        = list(string)
  description = "CIDR blocks allowed to access the Guacamole API (Orchestrator servers)."
  default     = ["10.0.0.0/16"]
}

variable "enable_flow_logs" {
  type        = bool
  description = "Whether to enable VPC Flow Logs for audit trail."
  default     = false
}

variable "flow_log_role_arn" {
  type        = string
  description = "IAM Role ARN for VPC Flow Logs (required if enable_flow_logs is true)."
  default     = ""
}

variable "flow_log_group_arn" {
  type        = string
  description = "CloudWatch Log Group ARN for VPC Flow Logs."
  default     = ""
}

variable "common_tags" {
  type        = map(string)
  description = "Common tags applied to all resources."
  default     = {}
}
