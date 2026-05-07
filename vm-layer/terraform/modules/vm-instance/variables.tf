# ============================================================================
# Terraform Module: VM Instance — Variables
# ============================================================================

# ---------------------------------------------------------------------------
# Session Identity
# ---------------------------------------------------------------------------

variable "session_id" {
  type        = string
  description = "Unique identifier for this session."
}

variable "user_id" {
  type        = string
  description = "ID of the user who owns this session."
}

variable "software_type" {
  type        = string
  description = "Type of software being shared (e.g., 'adobe-cc', 'autocad')."
}

# ---------------------------------------------------------------------------
# Instance Configuration
# ---------------------------------------------------------------------------

variable "ami_id" {
  type        = string
  description = "AMI ID of the pre-built session image."
}

variable "instance_type" {
  type        = string
  description = "EC2 instance type (e.g., 't3.large', 'g4dn.xlarge')."
  default     = "t3.large"
}

variable "os_type" {
  type        = string
  description = "Operating system type: 'windows' or 'linux'."
  default     = "windows"

  validation {
    condition     = contains(["windows", "linux"], var.os_type)
    error_message = "os_type must be 'windows' or 'linux'."
  }
}

variable "root_volume_size" {
  type        = number
  description = "Root EBS volume size in GB."
  default     = 100
}

variable "use_spot_instances" {
  type        = bool
  description = "Whether to use Spot Instances for cost savings."
  default     = false
}

# ---------------------------------------------------------------------------
# Session User
# ---------------------------------------------------------------------------

variable "session_username" {
  type        = string
  description = "Username for the session user account on the VM."
  default     = "session-user"
}

variable "session_password" {
  type        = string
  description = "Dynamically generated password for the session user."
  sensitive   = true
}

# ---------------------------------------------------------------------------
# Networking
# ---------------------------------------------------------------------------

variable "subnet_id" {
  type        = string
  description = "Subnet ID to launch the instance in (should be private)."
}

variable "security_group_ids" {
  type        = list(string)
  description = "Security group IDs to attach to the instance."
}

# ---------------------------------------------------------------------------
# IAM & Security
# ---------------------------------------------------------------------------

variable "instance_profile_name" {
  type        = string
  description = "IAM instance profile name for the EC2 instance."
  default     = ""
}

variable "kms_key_id" {
  type        = string
  description = "KMS key ID for EBS volume encryption."
  default     = ""
}

variable "key_pair_name" {
  type        = string
  description = "EC2 key pair name for SSH access (optional, for debugging)."
  default     = ""
}

# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

variable "ttl_minutes" {
  type        = number
  description = "Time-to-live in minutes before the VM is auto-destroyed."
  default     = 240 # 4 hours

  validation {
    condition     = var.ttl_minutes >= 15 && var.ttl_minutes <= 720
    error_message = "TTL must be between 15 and 720 minutes (12 hours)."
  }
}

# ---------------------------------------------------------------------------
# Monitoring
# ---------------------------------------------------------------------------

variable "enable_detailed_monitoring" {
  type        = bool
  description = "Enable detailed CloudWatch monitoring (1-minute intervals)."
  default     = false
}

variable "cloudwatch_config_param" {
  type        = string
  description = "SSM Parameter Store path for CloudWatch Agent configuration."
  default     = "/software-sharing/cloudwatch/config"
}

# ---------------------------------------------------------------------------
# Common
# ---------------------------------------------------------------------------

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
