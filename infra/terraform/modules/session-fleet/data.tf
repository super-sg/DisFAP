# ---------------------------------------------------------------------------
# session-fleet :: data.tf
#
# Ambient lookups and the locals that stitch the module together. Kept in one
# place so every other file can rely on `local.*` without repeating expressions.
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

# Available AZs in the target region, filtered to standard zones (excludes
# Local/Wavelength zones which cannot host our subnets).
data "aws_availability_zones" "available" {
  state = "available"

  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name

  # The AZs we actually spread across.
  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)

  # Deterministic /20 subnets carved from the VPC CIDR. Public subnets take the
  # low indices, private subnets the high indices, so the two ranges never
  # collide regardless of az_count.
  public_subnet_cidrs = [
    for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 4, i)
  ]
  private_subnet_cidrs = [
    for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 4, i + 8)
  ]

  # Management tags stamped onto everything. dfap:managed=true is the linchpin
  # of the reaper and the dead-man switch IAM condition — never omit it.
  common_tags = merge(var.tags, {
    "dfap:managed"   = "true"
    "dfap:module"    = "session-fleet"
    "dfap:terraform" = "true"
  })

  # Fully-qualified interface-endpoint service names. Kept as a set so the
  # aws_vpc_endpoint resource can for_each over them cleanly.
  interface_endpoint_services = toset([
    "ssm",         # SSM core (Session Manager, run command) — replaces SSH
    "ssmmessages", # SSM agent <-> service channel (Session Manager data plane)
    "ec2messages", # SSM agent <-> service channel (commands)
    "kms",         # envelope-decrypt EBS/S3 CMKs without leaving the VPC
    "ecr.api",     # ECR control plane (auth token, image metadata)
    "ecr.dkr",     # ECR data plane (layer pulls) for the control host stack
    "logs",        # CloudWatch Logs so agents ship logs without NAT
  ])
}
