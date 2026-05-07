# ============================================================================
# Terraform Module: VM Instance — Outputs
# ============================================================================

output "instance_id" {
  description = "EC2 instance ID of the session VM."
  value       = var.use_spot_instances ? aws_spot_instance_request.session_vm_spot[0].spot_instance_id : aws_instance.session_vm[0].id
}

output "private_ip" {
  description = "Private IP address of the session VM (used for Guacamole connection)."
  value       = var.use_spot_instances ? aws_spot_instance_request.session_vm_spot[0].private_ip : aws_instance.session_vm[0].private_ip
}

output "instance_state" {
  description = "Current state of the EC2 instance."
  value       = var.use_spot_instances ? aws_spot_instance_request.session_vm_spot[0].instance_state : aws_instance.session_vm[0].instance_state
}

output "session_id" {
  description = "Session ID associated with this VM."
  value       = var.session_id
}

output "rdp_port" {
  description = "RDP port for Windows VMs."
  value       = var.os_type == "windows" ? 3389 : null
}

output "vnc_port" {
  description = "VNC port for Linux VMs."
  value       = var.os_type == "linux" ? 5901 : null
}

output "connection_protocol" {
  description = "Protocol to use for Guacamole connection (rdp or vnc)."
  value       = var.os_type == "windows" ? "rdp" : "vnc"
}

output "ttl_expiry" {
  description = "Timestamp when this VM should be auto-destroyed."
  value       = timeadd(timestamp(), "${var.ttl_minutes}m")
}

output "connection_info" {
  description = "Complete connection info for Guacamole JSON token generation."
  sensitive   = true
  value = {
    hostname = var.use_spot_instances ? aws_spot_instance_request.session_vm_spot[0].private_ip : aws_instance.session_vm[0].private_ip
    port     = var.os_type == "windows" ? "3389" : "5901"
    protocol = var.os_type == "windows" ? "rdp" : "vnc"
    username = var.session_username
    password = var.session_password
  }
}
