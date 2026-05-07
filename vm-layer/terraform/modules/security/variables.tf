# ============================================================================
# Terraform Module: Security — Variables
# ============================================================================

variable "project_name" {
  type        = string
  description = "Project name for resource naming."
  default     = "software-sharing"
}

variable "common_tags" {
  type        = map(string)
  description = "Common tags applied to all resources."
  default     = {}
}
