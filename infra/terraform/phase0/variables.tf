# ---------------------------------------------------------------------------
# phase0 :: variables.tf
# ---------------------------------------------------------------------------

variable "aws_region" {
  description = "Region for the Phase-0 footprint."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix for all Phase-0 resources."
  type        = string
  default     = "disfap-phase0"
}

variable "session_ami_id" {
  description = "Hardened session workspace AMI (Packer-built). Required — no default, because the wrong image here is a security hole, not a convenience."
  type        = string
}

variable "control_host_ami_id" {
  description = "AMI for the t4g.small control host. Empty = use the latest Amazon Linux 2023 arm64 image resolved from SSM."
  type        = string
  default     = ""
}

variable "control_host_instance_type" {
  description = "Control host size. t4g.small is the Phase-0 baseline (2 vCPU / 2 GiB, ARM, cheapest that runs the compose stack)."
  type        = string
  default     = "t4g.small"
}

variable "budget_notification_email" {
  description = "Email for the $50 budget alarm."
  type        = string
}

variable "web_ingress_cidrs" {
  description = "CIDRs allowed to reach the control host on 443 (the web app). Defaults to the whole internet because contractors connect from anywhere; tighten to your office/VPN ranges if you can."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
