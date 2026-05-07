# ============================================================================
# Packer — Shared Variables
# Common variables used across all Packer templates in the VM Layer.
# ============================================================================

# ---------------------------------------------------------------------------
# AWS Configuration
# ---------------------------------------------------------------------------

variable "aws_region" {
  type        = string
  description = "AWS region where the AMI will be built and registered."
  default     = "us-east-1"
}

variable "aws_profile" {
  type        = string
  description = "AWS CLI profile to use for authentication. Leave empty to use default credentials chain."
  default     = ""
}

# ---------------------------------------------------------------------------
# Instance Configuration
# ---------------------------------------------------------------------------

variable "builder_instance_type" {
  type        = string
  description = "EC2 instance type used during the Packer build process. Larger instances build faster."
  default     = "t3.large"
}

variable "builder_volume_size" {
  type        = number
  description = "Size in GB of the root EBS volume during build. Must be large enough for all installed software."
  default     = 100
}

# ---------------------------------------------------------------------------
# Image Metadata
# ---------------------------------------------------------------------------

variable "project_name" {
  type        = string
  description = "Project name used for tagging and AMI naming."
  default     = "software-sharing"
}

variable "environment" {
  type        = string
  description = "Target environment for this image build (dev, staging, prod)."
  default     = "dev"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be one of: dev, staging, prod."
  }
}

variable "image_version" {
  type        = string
  description = "Semantic version tag for the AMI (e.g., 1.0.0). Used in AMI name for tracking."
  default     = "0.1.0"
}

# ---------------------------------------------------------------------------
# Session User
# ---------------------------------------------------------------------------

variable "session_username" {
  type        = string
  description = "Username for the limited-privilege account created on the VM for rentee sessions."
  default     = "session-user"
}

# ---------------------------------------------------------------------------
# Network / Security
# ---------------------------------------------------------------------------

variable "vpc_id" {
  type        = string
  description = "VPC ID where the temporary builder instance will be launched. Leave empty to use default VPC."
  default     = ""
}

variable "subnet_id" {
  type        = string
  description = "Subnet ID for the builder instance. Must have internet access for software downloads."
  default     = ""
}

# ---------------------------------------------------------------------------
# Software Configuration
# ---------------------------------------------------------------------------

variable "software_packages" {
  type        = list(string)
  description = "List of software identifiers to install on the image (e.g., ['adobe-creative-cloud', 'autocad'])."
  default     = []
}
