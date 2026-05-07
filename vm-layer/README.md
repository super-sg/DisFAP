# VM Layer — Software Subscription Sharing Platform

> Ephemeral cloud VM provisioning, lifecycle management, and browser-based remote access for software sharing sessions.

## Overview

The VM Layer is responsible for creating, managing, and destroying temporary virtual machines that host shared software subscriptions. It integrates with the platform's **Orchestrator** and **Apache Guacamole** to deliver a seamless browser-based experience where the end user (rentee) can access pre-installed software without ever seeing the actual credentials.

### Key Features

- **⚡ Fast Provisioning** — Pre-built AMIs via Packer mean VMs boot with software ready in under 60 seconds
- **🔒 Zero-Trust Security** — VMs in private subnets, no public IPs, credentials never stored on disk
- **⏱️ Auto-Destruction** — TTL enforcement + reaper cron ensures no orphaned VMs
- **💰 Cost Optimization** — Optional Spot Instance support, aggressive cleanup, encrypted EBS with auto-delete
- **🖥️ Browser Access** — HMAC-SHA256 signed JSON tokens for Guacamole RDP/VNC streaming

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              VM Layer                                    │
│                                                                          │
│  ┌─────────────┐    ┌──────────────┐    ┌────────────────────────────┐  │
│  │   Packer     │    │  Terraform   │    │     VM Manager Service     │  │
│  │  (Images)    │───▶│  (Infra)     │◀───│     (Node.js API)          │  │
│  └─────────────┘    └──────────────┘    │                            │  │
│                          │               │  ┌──────────┐ ┌─────────┐ │  │
│                          ▼               │  │Provisioner│ │Lifecycle│ │  │
│                    ┌──────────┐          │  └──────────┘ └─────────┘ │  │
│                    │  AWS EC2  │          │  ┌──────────────────────┐ │  │
│                    │ (Session  │◀─────────│  │ Connection Builder   │ │  │
│                    │   VMs)    │          │  │ (Guacamole JSON)     │ │  │
│                    └──────────┘          │  └──────────────────────┘ │  │
│                                          └────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| [Terraform](https://terraform.io) | ≥ 1.5.0 | Infrastructure provisioning |
| [Packer](https://packer.io) | ≥ 1.9.0 | AMI/image building |
| [AWS CLI](https://aws.amazon.com/cli/) | v2 | Cloud authentication |
| [Node.js](https://nodejs.org) | ≥ 18.0 | VM Manager service runtime |
| [Docker](https://docker.com) | (optional) | Running Guacamole locally |

---

## Quick Start

### 1. Clone & Install

```bash
cd vm-layer
make install          # Install Node.js dependencies
```

### 2. Configure Environment

```bash
cp vm-manager/.env.example vm-manager/.env
# Edit .env with your AWS credentials, AMI IDs, and Guacamole settings
```

### 3. Build AMI (First Time Only)

```bash
# Build the Windows session image
make build-image-windows

# Or build the Linux session image
make build-image-linux
```

### 4. Deploy Infrastructure

```bash
make init ENV=dev     # Initialize Terraform
make plan ENV=dev     # Review changes
make apply ENV=dev    # Deploy VPC, security groups, IAM roles
```

### 5. Start VM Manager

```bash
make start-dev        # Development mode with auto-reload
# or
make start            # Production mode
```

### 6. Test a Session

```bash
# Provision a VM
curl -X POST http://localhost:3001/api/vm/provision \
  -H "Content-Type: application/json" \
  -d '{"userId": "user-1", "softwareType": "adobe-cc", "osType": "windows"}'

# Get connection URL
curl http://localhost:3001/api/vm/sess-abc123/connect

# Destroy when done
curl -X DELETE http://localhost:3001/api/vm/sess-abc123
```

---

## Project Structure

```
vm-layer/
├── packer/                     # AMI image definitions
│   ├── base-windows.pkr.hcl   # Windows Server 2022 image
│   ├── base-linux.pkr.hcl     # Ubuntu 22.04 image
│   ├── variables.pkr.hcl      # Shared Packer variables
│   └── scripts/                # Provisioning scripts
│       ├── install-rdp.ps1     # RDP configuration
│       ├── install-software.ps1# Software installation
│       ├── harden-os.ps1       # Security hardening
│       └── install-vnc.sh      # VNC setup for Linux
├── terraform/
│   ├── modules/                # Reusable Terraform modules
│   │   ├── networking/         # VPC, subnets, security groups
│   │   ├── vm-instance/        # EC2 instance provisioning
│   │   └── security/           # IAM roles, KMS keys
│   └── environments/           # Environment configurations
│       ├── dev/                # Development settings
│       └── prod/               # Production settings
├── vm-manager/                 # Node.js lifecycle service
│   ├── src/
│   │   ├── index.js            # Express API server
│   │   ├── provisioner.js      # EC2 provisioning logic
│   │   ├── lifecycle.js        # TTL enforcement & health checks
│   │   ├── connection-builder.js # Guacamole JSON auth tokens
│   │   └── config.js           # Configuration loader
│   └── tests/                  # Unit tests
├── docs/                       # Extended documentation
├── Makefile                    # Developer shortcuts
└── .gitignore
```

---

## API Reference

### `POST /api/vm/provision`

Provision a new session VM.

**Request:**
```json
{
  "userId": "user-123",
  "softwareType": "adobe-cc",
  "osType": "windows",
  "instanceType": "t3.large",
  "ttlMinutes": 240
}
```

**Response (201):**
```json
{
  "success": true,
  "session": {
    "sessionId": "sess-a1b2c3d4",
    "instanceId": "i-0abcdef1234567890",
    "privateIp": "10.0.2.50",
    "protocol": "rdp",
    "port": 3389,
    "status": "ready",
    "ttlExpiry": "2024-01-01T04:00:00.000Z"
  }
}
```

### `GET /api/vm/:sessionId/status`

Get the current status of a session VM.

### `GET /api/vm/:sessionId/connect`

Get a Guacamole connection URL. Triggers the HMAC-SHA256 signed JSON token flow.

**Response:**
```json
{
  "success": true,
  "connection": {
    "connectionUrl": "http://guacamole:8080/guacamole/#/client/...",
    "expiresAt": "2024-01-01T04:00:00.000Z",
    "protocol": "rdp"
  }
}
```

### `DELETE /api/vm/:sessionId`

Destroy a session VM and clean up all resources.

### `GET /api/vm/health`

Service health check.

---

## Configuration Reference

See [`.env.example`](vm-manager/.env.example) for all configurable environment variables.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3001 | API server port |
| `AWS_REGION` | us-east-1 | AWS region |
| `DEFAULT_TTL_MINUTES` | 240 | Session duration |
| `MAX_CONCURRENT_VMS` | 5 | Max VMs per user |
| `GUACAMOLE_SECRET_KEY` | (required) | HMAC-SHA256 signing key |
| `HEALTH_CHECK_INTERVAL_MS` | 30000 | Health check frequency |
| `REAPER_INTERVAL_MS` | 300000 | Orphan cleanup frequency |

---

## Documentation

- [Architecture Deep-Dive](docs/ARCHITECTURE.md) — Network topology, state machine, data flow
- [Security Model](docs/SECURITY.md) — Zero-trust, encryption, credential flow
- [Operational Runbook](docs/RUNBOOK.md) — Build, deploy, troubleshoot, emergency cleanup

---

## Make Commands

```bash
make help                 # Show all available commands
make build-image-windows  # Build Windows AMI
make build-image-linux    # Build Linux AMI
make plan ENV=dev         # Terraform plan
make apply ENV=dev        # Terraform apply
make destroy ENV=dev      # Destroy infrastructure
make install              # Install Node.js dependencies
make test                 # Run unit tests
make lint                 # Lint source code
make check-all            # Run all validations
make clean                # Remove generated files
```

---

## License

MIT
