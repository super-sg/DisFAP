# Security Model — VM Layer

## Principles

1. **Zero Trust** — No component trusts another by default. All communication is authenticated.
2. **Least Privilege** — Every role has the minimum permissions needed to function.
3. **Defense in Depth** — Multiple layers of security protect credentials and sessions.
4. **Ephemeral by Design** — Nothing persists. VMs, credentials, and sessions are temporary.

---

## Credential Flow

Credentials are the most sensitive data in the system. Here's how they're protected at every step:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Credential Lifecycle                              │
│                                                                     │
│  1. Owner enters software credentials                               │
│     └──▶ Encrypted in transit (HTTPS) to Orchestrator               │
│                                                                     │
│  2. Orchestrator sends to HashiCorp Vault                           │
│     └──▶ Encrypted at rest (AES-256-GCM)                           │
│     └──▶ Access controlled by Vault policies                       │
│                                                                     │
│  3. VM Manager generates a RANDOM session password                  │
│     └──▶ This is NOT the owner's credential                        │
│     └──▶ Used only for RDP/VNC authentication to the VM            │
│                                                                     │
│  4. Session password injected via EC2 UserData                      │
│     └──▶ Set in memory, never written to disk                      │
│     └──▶ UserData is base64-encoded (not stored in instance)       │
│                                                                     │
│  5. Session password embedded in Guacamole JSON token               │
│     └──▶ HMAC-SHA256 signed (tamper-proof)                         │
│     └──▶ Token has TTL (auto-expires)                              │
│     └──▶ Rentee NEVER sees the password                            │
│                                                                     │
│  6. VM terminated → password ceases to exist                        │
│     └──▶ No credential remnants on any system                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Insight

The **owner's actual software credentials** (e.g., Adobe login) are handled by the Orchestrator + Vault layers, NOT by the VM Layer. The VM Layer only deals with **session passwords** — randomly generated, single-use passwords for RDP/VNC access to the VM itself.

---

## Network Security

### Security Group Chain

```
Internet → [HTTPS:443] → Guacamole SG → [RDP:3389/VNC:5901] → Session VM SG
```

- **Session VMs** accept connections ONLY from the Guacamole security group
- No CIDR-based rules on VMs — even internal networks can't directly reach them
- **Outbound only via NAT** — VMs can activate licenses but can't receive unsolicited traffic

### No Public IPs

Session VMs are launched in **private subnets** with `map_public_ip_on_launch = false`. There is no path from the internet to a session VM except through Guacamole.

---

## VM Hardening

### Windows

| Control | Implementation |
|---------|---------------|
| SMBv1 disabled | `Set-SmbServerConfiguration -EnableSMB1Protocol $false` |
| Firewall enabled | Default deny inbound, RDP allowed |
| NLA disabled | Required for Guacamole compatibility |
| PowerShell blocked | ACL deny for session-user |
| CMD blocked | ACL deny for session-user |
| Registry Editor blocked | ACL deny for session-user |
| Task Manager blocked | ACL deny for session-user |
| Clipboard disabled | RDP policy + Guacamole config |
| Drive mapping disabled | RDP policy |
| Audit logging | All logon/logoff events |
| Windows Defender | Real-time protection enabled |
| Admin account | Disabled at boot via UserData |

### Linux

| Control | Implementation |
|---------|---------------|
| UFW firewall | Default deny, VNC:5901 + SSH:22 only |
| fail2ban | Brute-force protection |
| Root SSH disabled | `PermitRootLogin no` |
| No sudo | Session user removed from sudo group |
| Audit daemon | `auditd` enabled |
| Unnecessary services | CUPS, Avahi disabled |

---

## Encryption

| Layer | Method | Key Management |
|-------|--------|---------------|
| EBS volumes | AES-256 | AWS KMS with auto-rotation |
| Data in transit (Guacamole) | WebSocket over HTTPS | TLS 1.2+ |
| Guacamole tokens | HMAC-SHA256 | Shared secret key |
| UserData | Base64 (not encryption) | Runs once, not persisted |
| Terraform state | S3 SSE + DynamoDB | S3 bucket encryption |

---

## IAM — Principle of Least Privilege

### Session VM Role

```
✅ CloudWatch: PutMetricData, PutLogEvents
✅ SSM: GetParameter (for CloudWatch config only)
❌ EC2: No access
❌ S3: No access
❌ IAM: No access
```

### VM Manager Role

```
✅ EC2: RunInstances, TerminateInstances, Describe*
✅ EC2: CreateTags, DeleteTags
✅ EC2: SpotInstance management
✅ IAM: PassRole (session VM role only)
❌ IAM: CreateRole, AttachPolicy
❌ S3: No access
❌ KMS: Encrypt/Decrypt (only via EBS)
```

---

## Session Isolation

Each session VM is completely isolated:

- **Separate EC2 instance** — No shared compute
- **Separate EBS volume** — No shared storage
- **Unique password** — Generated per session
- **Unique Guacamole token** — Scoped to one VM
- **TTL-bound** — Auto-destroyed, no data persistence

One user's session cannot access another user's session. Even if a session user escapes the sandboxed environment, they land on an instance with minimal IAM permissions and no access to other VMs.

---

## Threat Model

| Threat | Mitigation |
|--------|-----------|
| Credential theft via clipboard | Clipboard disabled in RDP/VNC + Guacamole |
| Credential theft via network sniffing | Private subnet, TLS, HMAC-signed tokens |
| VM escape | Minimal IAM, no access to other resources |
| Session hijacking | TTL-bound tokens, HMAC verification |
| Orphaned VMs running up costs | Reaper cron every 5 minutes |
| Brute-force on VM | Security group restricts to Guacamole only |
| Admin access by session user | Admin account disabled, PowerShell/CMD blocked |
| Data exfiltration | Drive mapping + printing disabled |
