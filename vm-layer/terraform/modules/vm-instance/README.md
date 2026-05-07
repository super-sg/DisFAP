# VM Instance Module

Creates ephemeral EC2 instances from pre-built AMIs for software sharing sessions.

## Features

- **Dynamic password injection** via user data — credentials never stored on disk
- **Spot Instance support** for cost optimization (optional)
- **Encrypted EBS volumes** with KMS
- **Session tagging** for lifecycle tracking (session ID, user ID, TTL expiry)
- **IMDSv2 enforcement** for metadata security
- **Auto-terminate on shutdown** — no orphaned instances

## Usage

```hcl
module "session_vm" {
  source = "../../modules/vm-instance"

  session_id    = "sess-abc123"
  user_id       = "user-xyz789"
  software_type = "adobe-cc"

  ami_id        = "ami-0123456789abcdef0"
  instance_type = "t3.large"
  os_type       = "windows"

  session_username = "session-user"
  session_password = "dynamically-generated"

  subnet_id          = module.networking.private_subnet_id
  security_group_ids = [module.networking.session_vm_security_group_id]

  ttl_minutes        = 240
  use_spot_instances = false

  common_tags = {
    Project     = "software-sharing"
    Environment = "dev"
  }
}
```

## Outputs

| Output | Description |
|--------|-------------|
| `instance_id` | EC2 instance ID |
| `private_ip` | Private IP for Guacamole connection |
| `instance_state` | Current EC2 instance state |
| `connection_protocol` | `rdp` or `vnc` |
| `connection_info` | Complete connection details (sensitive) |
| `ttl_expiry` | When the VM should be auto-destroyed |
