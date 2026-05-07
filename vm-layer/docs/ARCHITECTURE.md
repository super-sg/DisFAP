# Architecture — VM Layer

## System Context

The VM Layer sits in the middle of the Software Subscription Sharing platform:

```
                     ┌─────────────┐
                     │  Frontend   │
                     │ (Web App)   │
                     └──────┬──────┘
                            │
                     ┌──────▼──────┐
                     │ Orchestrator │
                     │  (Backend)   │
                     └──────┬──────┘
                            │
              ┌─────────────▼─────────────┐
              │       VM Layer            │
              │  ┌────────────────────┐   │
              │  │   VM Manager API   │   │
              │  └─────┬──────┬───────┘   │
              │        │      │           │
              │   ┌────▼──┐ ┌─▼────────┐  │
              │   │ AWS   │ │Guacamole │  │
              │   │ EC2   │ │ JSON Auth│  │
              │   └───────┘ └──────────┘  │
              └───────────────────────────┘
                            │
                     ┌──────▼──────┐
                     │  Rentee's   │
                     │  Browser    │
                     └─────────────┘
```

---

## VM Lifecycle State Machine

```
                        ┌─────────────────┐
                        │  PROVISIONING   │
                        │ (EC2 launching) │
                        └────────┬────────┘
                                 │
                        ┌────────▼────────┐
                   ┌───▶│     READY       │
                   │    │ (VM running,    │
                   │    │  waiting for    │
                   │    │  connection)    │
                   │    └────────┬────────┘
                   │             │ User connects via Guacamole
                   │    ┌────────▼────────┐
                   │    │    ACTIVE        │
                   │    │ (User is using  │
                   │    │  the software)  │
                   │    └────────┬────────┘
                   │             │
                   │    ┌────────▼────────┐
                   │    │     IDLE         │
                   │    │ (No activity    │
                   │    │  detected)      │
                   │    └────────┬────────┘
                   │             │ TTL expires or idle timeout
            ┌──────┴───┐ ┌──────▼────────┐
            │  FAILED   │ │ TERMINATING   │
            │(Provision │ │ (Shutting     │
            │ error)    │ │  down)        │
            └──────┬────┘ └──────┬────────┘
                   │             │
                   │    ┌────────▼────────┐
                   └───▶│  TERMINATED     │
                        │ (Resources      │
                        │  cleaned up)    │
                        └─────────────────┘
```

---

## Network Topology

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        VPC (10.0.0.0/16)                                 │
│                                                                          │
│  ┌─────────────────────────────────────────┐                            │
│  │       Public Subnet (10.0.1.0/24)        │                            │
│  │                                           │                            │
│  │  ┌─────────────┐    ┌─────────────────┐  │                            │
│  │  │ NAT Gateway │    │   Guacamole     │  │                            │
│  │  │             │    │   Server        │  │◀─── Internet (443/80)      │
│  │  └──────┬──────┘    └────────┬────────┘  │                            │
│  │         │                    │            │                            │
│  └─────────┼────────────────────┼────────────┘                            │
│            │                    │                                          │
│            │                    │ RDP:3389 / VNC:5901                      │
│  ┌─────────┼────────────────────┼────────────┐                            │
│  │         │  Private Subnet (10.0.2.0/24)   │                            │
│  │         │                    │             │                            │
│  │         ▼                    ▼             │                            │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐│                            │
│  │  │ Session  │  │ Session  │  │ Session  ││                            │
│  │  │  VM #1   │  │  VM #2   │  │  VM #3   ││                            │
│  │  │(Windows) │  │ (Linux)  │  │(Windows) ││                            │
│  │  └──────────┘  └──────────┘  └──────────┘│                            │
│  │         │                                  │                            │
│  └─────────┼──────────────────────────────────┘                            │
│            │                                                               │
│            └──── Outbound only via NAT (license activation)               │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

**Key Design Decisions:**

1. **Private subnets only** — Session VMs have no public IPs. They are invisible to the internet.
2. **Guacamole as the gateway** — The only path to reach a VM is through Guacamole's HTML5 RDP/VNC proxy.
3. **NAT for outbound** — VMs need outbound internet for software license activation, but can't receive inbound connections from the internet.
4. **Security group chaining** — The VM security group only allows inbound from the Guacamole security group. No CIDR-based rules.

---

## Data Flow: Session Lifecycle

```
1. Orchestrator calls POST /api/vm/provision
        │
2. VM Manager generates session ID + random password
        │
3. VM Manager calls AWS EC2 RunInstances
   - Uses pre-built AMI (Packer)
   - Injects password via UserData script
   - Tags instance with session metadata
        │
4. EC2 instance boots in private subnet
   - UserData script sets session-user password
   - UserData script starts VNC/enables RDP
   - UserData writes SESSION_READY signal
        │
5. VM Manager detects 'running' state
   - Updates session status to 'ready'
   - Returns session info to Orchestrator
        │
6. Orchestrator calls GET /api/vm/{id}/connect
        │
7. VM Manager builds Guacamole JSON token
   - Embeds: protocol, hostname, port, username, password
   - Signs with HMAC-SHA256 (shared secret)
   - POSTs to Guacamole /api/tokens
        │
8. Guacamole verifies signature, extracts connection params
   - guacd daemon connects to VM via RDP/VNC
   - Returns auth token
        │
9. VM Manager returns connection URL to Orchestrator
        │
10. Orchestrator redirects rentee's browser to Guacamole
    - Software is already open and logged in
    - Rentee never sees the actual password
        │
11. [Session active — Lifecycle Manager monitors]
    - Health checks every 30 seconds
    - TTL countdown running
    - Idle detection active
        │
12. TTL expires or user disconnects
    - Lifecycle Manager calls destroyVM()
    - EC2 instance terminated
    - EBS volumes auto-deleted
    - Session marked as terminated
```

---

## Cost Optimization

| Strategy | Savings | Trade-off |
|----------|---------|-----------|
| **Spot Instances** | Up to 90% | 2-minute interruption risk |
| **Auto-destroy (TTL)** | Prevents runaway costs | Fixed session duration |
| **Reaper cron** | Safety net for orphans | 5-minute scan interval |
| **EBS delete-on-terminate** | No orphaned volumes | Session data is ephemeral |
| **Right-sized instances** | Use t3 for basic, g4dn for GPU | Requires AMI per type |

---

## Technology Choices

| Component | Choice | Why |
|-----------|--------|-----|
| **IaC** | Terraform | Industry standard, modular, state management |
| **Image Builder** | Packer | Hashicorp ecosystem, multi-provider, reproducible |
| **Cloud Provider** | AWS (primary) | EC2 Spot, Security Groups, KMS, IAM |
| **Remote Access** | Apache Guacamole | HTML5, no plugins, JSON auth extension |
| **VM Manager** | Node.js / Express | Fast I/O, AWS SDK v3, lightweight |
| **Monitoring** | CloudWatch | Native integration, no extra infra |
| **Encryption** | AWS KMS | Managed key rotation, IAM integration |
