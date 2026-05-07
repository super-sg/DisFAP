# ============================================================================
# Terraform Module: Security — Outputs
# ============================================================================

output "session_vm_role_arn" {
  description = "ARN of the IAM role for session VMs."
  value       = aws_iam_role.session_vm.arn
}

output "session_vm_instance_profile_name" {
  description = "Name of the IAM instance profile for session VMs."
  value       = aws_iam_instance_profile.session_vm.name
}

output "vm_manager_role_arn" {
  description = "ARN of the IAM role for the VM Manager service."
  value       = aws_iam_role.vm_manager.arn
}

output "ebs_kms_key_id" {
  description = "KMS key ID for EBS volume encryption."
  value       = aws_kms_key.ebs_encryption.key_id
}

output "ebs_kms_key_arn" {
  description = "KMS key ARN for EBS volume encryption."
  value       = aws_kms_key.ebs_encryption.arn
}
