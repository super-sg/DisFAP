# ---------------------------------------------------------------------------
# session-fleet :: outputs.tf
#
# Everything a root config (phase0) or the running control plane needs to wire
# itself to the fleet. IDs and ARNs only — no secrets.
# ---------------------------------------------------------------------------

# --- Network ----------------------------------------------------------------
output "vpc_id" {
  description = "ID of the fleet VPC."
  value       = aws_vpc.this.id
}

output "vpc_cidr" {
  description = "CIDR of the fleet VPC."
  value       = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  description = "Public subnet IDs (control host, optional NAT instance)."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Private subnet IDs (session VMs, endpoint ENIs)."
  value       = aws_subnet.private[*].id
}

# --- Security groups --------------------------------------------------------
output "guacd_host_sg_id" {
  description = "SG for the broker/guacd host. Attach the control host to this."
  value       = aws_security_group.guacd_host.id
}

output "session_template_sg_id" {
  description = "Per-session SG TEMPLATE. The pool manager clones this per session."
  value       = aws_security_group.session_template.id
}

# --- Launch template --------------------------------------------------------
output "session_launch_template_id" {
  description = "Launch template the pool manager calls RunInstances against."
  value       = aws_launch_template.session.id
}

output "session_launch_template_latest_version" {
  description = "Latest version number of the session launch template."
  value       = aws_launch_template.session.latest_version
}

# --- IAM --------------------------------------------------------------------
output "instance_role_arn" {
  description = "ARN of the session-VM instance role (self-terminate + SSM)."
  value       = aws_iam_role.instance.arn
}

output "instance_profile_arn" {
  description = "ARN of the session-VM instance profile."
  value       = aws_iam_instance_profile.instance.arn
}

output "pool_manager_role_arn" {
  description = "ARN of the pool-manager role (assumable by EC2)."
  value       = aws_iam_role.pool_manager.arn
}

output "pool_manager_policy_arn" {
  description = "ARN of the pool-manager managed policy — attach to an existing role (e.g. the control host) to grant fleet-management rights."
  value       = aws_iam_policy.pool_manager.arn
}

# --- Recordings -------------------------------------------------------------
output "recordings_bucket_name" {
  description = "Name of the Object-Lock recordings bucket."
  value       = aws_s3_bucket.recordings.bucket
}

output "recordings_bucket_arn" {
  description = "ARN of the recordings bucket."
  value       = aws_s3_bucket.recordings.arn
}

output "recordings_kms_key_arn" {
  description = "ARN of the recordings CMK (grant the recorder role kms:GenerateDataKey on this)."
  value       = aws_kms_key.recordings.arn
}

output "ebs_kms_key_arn" {
  description = "ARN of the session-EBS CMK."
  value       = aws_kms_key.ebs.arn
}
