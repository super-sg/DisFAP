# ---------------------------------------------------------------------------
# phase0 :: outputs.tf
# ---------------------------------------------------------------------------

output "control_host_public_ip" {
  description = "Elastic IP of the control host — point your DNS / web client here."
  value       = aws_eip.control_host.public_ip
}

output "control_host_instance_id" {
  description = "Control host instance ID (for Session Manager access)."
  value       = aws_instance.control_host.id
}

output "vpc_id" {
  description = "Fleet VPC ID."
  value       = module.fleet.vpc_id
}

output "private_subnet_ids" {
  description = "Private subnets session VMs launch into."
  value       = module.fleet.private_subnet_ids
}

output "session_launch_template_id" {
  description = "Launch template the pool manager runs against."
  value       = module.fleet.session_launch_template_id
}

output "session_template_sg_id" {
  description = "Per-session SG template the pool manager clones."
  value       = module.fleet.session_template_sg_id
}

output "recordings_bucket_name" {
  description = "Object-Lock recordings bucket."
  value       = module.fleet.recordings_bucket_name
}
