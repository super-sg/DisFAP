# ============================================================================
# Terraform Module: Networking — Outputs
# ============================================================================

output "vpc_id" {
  description = "ID of the created VPC."
  value       = aws_vpc.session_vpc.id
}

output "public_subnet_id" {
  description = "ID of the public subnet (Guacamole, NAT Gateway)."
  value       = aws_subnet.public.id
}

output "private_subnet_id" {
  description = "ID of the private subnet (session VMs)."
  value       = aws_subnet.private.id
}

output "session_vm_security_group_id" {
  description = "Security group ID for session VMs."
  value       = aws_security_group.session_vm.id
}

output "guacamole_security_group_id" {
  description = "Security group ID for the Guacamole server."
  value       = aws_security_group.guacamole.id
}

output "nat_gateway_ip" {
  description = "Elastic IP of the NAT Gateway."
  value       = aws_eip.nat.public_ip
}
