# Networking Module

Creates the network infrastructure for ephemeral session VMs.

## Architecture

- **VPC** with DNS support enabled
- **Public Subnet** — hosts Guacamole server and NAT Gateway
- **Private Subnet** — hosts session VMs (no public IPs)
- **NAT Gateway** — allows private VMs to reach the internet for software license activation
- **Security Groups** — enforces that only Guacamole can reach VMs on RDP/VNC ports

## Security Model

```
Internet → Guacamole SG (443/80) → Guacamole Server
                                        ↓
                                   Session VM SG (3389/5901) → Session VM
                                        ↓
Session VM → NAT Gateway → Internet (outbound only, for license activation)
```

## Usage

```hcl
module "networking" {
  source = "../../modules/networking"

  project_name             = "software-sharing"
  vpc_cidr                 = "10.0.0.0/16"
  public_subnet_cidr       = "10.0.1.0/24"
  private_subnet_cidr      = "10.0.2.0/24"
  availability_zone        = "us-east-1a"
  orchestrator_cidr_blocks = ["10.0.0.0/16"]

  common_tags = {
    Project     = "software-sharing"
    Environment = "dev"
  }
}
```

## Outputs

| Output | Description |
|--------|-------------|
| `vpc_id` | ID of the VPC |
| `public_subnet_id` | Public subnet for Guacamole |
| `private_subnet_id` | Private subnet for session VMs |
| `session_vm_security_group_id` | SG allowing only Guacamole access |
| `guacamole_security_group_id` | SG for the Guacamole server |
| `nat_gateway_ip` | Elastic IP of the NAT Gateway |
