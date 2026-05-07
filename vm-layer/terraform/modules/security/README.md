# Security Module

Creates IAM roles, instance profiles, and KMS keys for the VM Layer.

## Resources Created

| Resource | Purpose |
|----------|---------|
| `session_vm` IAM Role | Minimal permissions for session VMs (CloudWatch only) |
| `session_vm` Instance Profile | Attached to EC2 instances |
| `vm_manager` IAM Role | EC2 lifecycle management for the VM Manager service |
| KMS Key | Encrypts EBS volumes with automatic key rotation |

## Principle of Least Privilege

- **Session VMs** can only push CloudWatch metrics/logs and read SSM parameters
- **VM Manager** can only manage EC2 instances tagged with the project name
- **KMS key** is restricted to the two roles above

## Usage

```hcl
module "security" {
  source       = "../../modules/security"
  project_name = "software-sharing"

  common_tags = {
    Project     = "software-sharing"
    Environment = "dev"
  }
}
```
