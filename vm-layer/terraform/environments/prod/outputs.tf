# ============================================================================
# Terraform Environment: Prod — Outputs
# ============================================================================

output "vpc_id" {
  value = module.networking.vpc_id
}

output "private_subnet_id" {
  value = module.networking.private_subnet_id
}

output "session_vm_security_group_id" {
  value = module.networking.session_vm_security_group_id
}

output "session_vm_instance_profile" {
  value = module.security.session_vm_instance_profile_name
}

output "ebs_kms_key_id" {
  value = module.security.ebs_kms_key_id
}
