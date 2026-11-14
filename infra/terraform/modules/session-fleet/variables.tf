# ---------------------------------------------------------------------------
# session-fleet :: variables.tf
#
# The full input surface of the fleet module. Every knob that affects cost or
# tenant isolation is surfaced here with a safe default (cheapest / most-locked)
# so that a caller who sets nothing still gets a correct, inexpensive footprint.
# ---------------------------------------------------------------------------

variable "name_prefix" {
  description = "Prefix applied to every resource name and Name tag (e.g. \"disfap-phase0\"). Keeps parallel deployments (dev/stage/prod) from colliding."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.name_prefix))
    error_message = "name_prefix must be 2-31 chars, lowercase alphanumeric or hyphen, starting with a letter."
  }
}

variable "aws_region" {
  description = "Region the fleet lives in. Used to construct interface-endpoint service names and IAM ARNs. Must match the provider's region."
  type        = string
}

# --- Networking -------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR for the fleet VPC. /16 gives ample room for a large session pool without ever needing a second VPC."
  type        = string
  default     = "10.42.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0))
    error_message = "vpc_cidr must be a valid IPv4 CIDR block."
  }
}

variable "az_count" {
  description = "Number of Availability Zones to spread subnets across. Two is the DisFAP baseline: enough for AZ resilience of the control host, cheap enough for Phase-0 (endpoints are per-AZ and billed per-AZ-hour)."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3. One AZ has no resilience; more than 3 multiplies interface-endpoint cost for no Phase-0 benefit."
  }
}

variable "enable_nat_instance" {
  description = <<-EOT
    When true, provision a single t4g.nano NAT *instance* (not a NAT Gateway) in
    the first public subnet and route private egress through it. DEFAULT OFF:
    Phase-0 has no general-purpose private egress at all — private instances reach
    AWS APIs exclusively through the VPC interface/gateway endpoints in network.tf,
    which is both cheaper (no ~$32/mo NAT Gateway, no per-GB processing) and a
    tighter security posture (no arbitrary outbound internet from tenant subnets).
    Flip this on only if a workspace image genuinely needs to reach a
    non-AWS-endpoint host and you accept the added egress surface.
  EOT
  type        = bool
  default     = false
}

variable "nat_instance_type" {
  description = "Instance type for the optional NAT instance. t4g.nano (ARM) is the cheapest instance that comfortably NATs a small pool."
  type        = string
  default     = "t4g.nano"
}

variable "nat_instance_ami_id" {
  description = "AMI for the optional NAT instance (an ARM64 image with IP forwarding + masquerade configured, e.g. fck-nat or a hardened AL2023). Empty string is only valid when enable_nat_instance = false."
  type        = string
  default     = ""

  validation {
    # Enforce the coupling: you cannot ask for a NAT instance without giving it an image.
    condition     = !var.enable_nat_instance || length(var.nat_instance_ami_id) > 0
    error_message = "nat_instance_ami_id must be set when enable_nat_instance is true."
  }
}

# --- Session VMs / launch template -----------------------------------------

variable "session_ami_id" {
  description = "AMI ID for session workspace VMs. This is the hardened, Packer-built image whose snapshot SHA is recorded per session (ADR-004). Required."
  type        = string

  validation {
    condition     = can(regex("^ami-[0-9a-f]{8,}$", var.session_ami_id))
    error_message = "session_ami_id must be a valid ami-* identifier."
  }
}

variable "session_instance_type" {
  description = "Default instance type baked into the launch template. The pool manager may override per-launch, but this is the Phase-0 default."
  type        = string
  default     = "t3.large"
}

variable "session_root_volume_gb" {
  description = "Root EBS volume size (GiB) for session VMs. Large enough for a Windows workspace image; delete_on_termination is always true (burn-after-reading)."
  type        = number
  default     = 60
}

variable "rdp_port" {
  description = "TCP port the session VM exposes RDP on. The per-session SG allows ingress ONLY from the guacd SG on this port. Kept a variable so a VNC/SSH fleet can reuse the module."
  type        = number
  default     = 3389
}

variable "metadata_hop_limit" {
  description = "IMDSv2 PUT response hop limit for session VMs. 1 keeps IMDS credentials reachable only from the host network stack itself (not from a nested container), which is correct for a pixel-only workspace. Raise only if the image runs its agent in a container."
  type        = number
  default     = 1

  validation {
    condition     = var.metadata_hop_limit >= 1 && var.metadata_hop_limit <= 2
    error_message = "metadata_hop_limit must be 1 (default, tightest) or 2."
  }
}

# --- Per-session egress allowlist ------------------------------------------

variable "session_egress_allowlist" {
  description = <<-EOT
    Egress rules stamped onto the per-session SG template. DEFAULT EMPTY =
    default-deny: a session VM may make NO outbound connections. This is the
    correct pixel-only posture — the workspace pulls nothing and exfiltrates
    nothing. Add entries ONLY for a specific, audited destination the workload
    truly needs (e.g. an internal artifact host). Each entry becomes one egress
    rule; there is deliberately no "0.0.0.0/0 all ports" convenience.
  EOT
  type = list(object({
    description = string
    cidr        = string
    from_port   = number
    to_port     = number
    protocol    = string # "tcp" | "udp"
  }))
  default = []

  validation {
    condition = alltrue([
      for r in var.session_egress_allowlist :
      contains(["tcp", "udp"], r.protocol) && can(cidrhost(r.cidr, 0))
    ])
    error_message = "Each egress rule needs protocol tcp|udp and a valid CIDR."
  }

  validation {
    # Guard against someone quietly re-opening the world through the allowlist.
    condition = alltrue([
      for r in var.session_egress_allowlist : r.cidr != "0.0.0.0/0"
    ])
    error_message = "session_egress_allowlist must not contain 0.0.0.0/0 — an open-world egress rule defeats pixel-only isolation. Use a specific CIDR."
  }
}

# --- Recordings bucket ------------------------------------------------------

variable "recording_retention_days" {
  description = "Object Lock COMPLIANCE retention (days) for session recordings. COMPLIANCE means not even the root account can delete or shorten within this window — the point of the tamper-evident audit trail. 365 = one year default."
  type        = number
  default     = 365

  validation {
    condition     = var.recording_retention_days >= 1
    error_message = "recording_retention_days must be at least 1."
  }
}

# --- Budget guardrail -------------------------------------------------------

variable "budget_limit_usd" {
  description = "Monthly AWS budget threshold in USD. Phase-0 guardrail is $50 (see brief / architecture)."
  type        = number
  default     = 50
}

variable "budget_notification_email" {
  description = "Email address that receives budget alarm notifications at the 80% (forecast) and 100% (actual) thresholds."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.budget_notification_email))
    error_message = "budget_notification_email must be a valid email address."
  }
}

# --- Tagging ----------------------------------------------------------------

variable "tags" {
  description = "Additional tags merged onto every resource. The module always adds dfap:* management tags on top."
  type        = map(string)
  default     = {}
}
