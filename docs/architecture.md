# DisFAP Architecture

For the security guarantees and threat model, see [security.md](security.md). For why the load-bearing decisions were made, see [adr/](adr/).

## Component map

```
┌──────────┐   wss:// (token in first frame)   ┌──────────────┐  TCP 4822 mTLS  ┌───────┐  RDP 3389  ┌────────────┐
│ Browser  │ ────────────────────────────────► │    Broker    │ ──────────────► │ guacd │ ─────────► │ Session VM │
│ (canvas) │ ◄──────── filtered pixels ─────── │ (Node)       │                 └───────┘  (priv.    │ (ephemeral)│
└──────────┘                                   │  · token     │                            subnet)   └────────────┘
     │                                         │  · filter    │                                            ▲
     │ HTTPS                                   │  · recording │◄───── credential (read-once) ──────┐       │
     ▼                                         └──────┬───────┘                                    │       │
┌──────────────────────────────┐                      │                                     ┌──────┴──┐    │
│ Control plane (services/api) │ ─── session state ───┘                                     │  Vault  │    │
│  sessions · pool · reaper    │ ─────────── mint credential at claim ────────────────────► │         │    │
│  billing · audit             │                                                            └─────────┘    │
└──────────┬───────────────────┘                                                                           │
           │  RunInstances (launch template) · TerminateInstances · tags                                   │
           └───────────────────────────────────────────────────────────────────────────────────────────────┘
```

Terraform manages the fleet (VPC, SGs, IAM, launch templates, guacd nodes). It does **not** run per session — see [adr/001](adr/001-warm-pool-over-terraform-per-session.md).

## Session lifecycle

```
requested → allocating → ready → connected ⇄ idle → disconnected → terminating → ended
                │                                                       ▲
                └────────────────────── failed ─────────────────────────┘
```

1. `POST /sessions` — control plane authenticates user, checks org quota/concurrency, claims a VM from the pool (`FOR UPDATE SKIP LOCKED`; empty pool → cold launch + progress UI).
2. At claim: per-session security group created; session credential minted (Linux: Vault SSH-signed cert; Windows: random password set via SSM, stored in Vault kv-v2 with 15-min TTL).
3. Control plane mints a `DFAP1` connect token (60 s, single-use) and returns it with the broker URL.
4. Browser opens WebSocket, sends token in the first frame. Broker verifies (algorithm pinned, `jti` burned in Redis, replay ⇒ terminate), resolves `sid` → VM address, reads the credential from Vault (response-wrapped, read-once), connects via guacd.
5. Pixels flow through the instruction filter both directions. Recording tees off at the broker/guacd node to S3 Object Lock.
6. Idle: warn at 10 min, disconnect at 15, terminate at 17. Reconnects use a rotating 5-min reconnect token issued over the live WebSocket. Hard cap 8 h.
7. Teardown: instance terminated, SG deleted, Vault credential path revoked, `usage_records` row written with `billable_seconds` and real `compute_cost_usd`.

## Teardown: five independent layers

Orphaned instances are the platform's largest silent cost risk. Each layer assumes the previous ones failed:

1. Normal path — broker signals disconnect, API terminates after grace.
2. **Tag-on-create** in the launch template (atomic): `dfap:session_id`, `dfap:expires_at`, `dfap:managed=true`.
3. **Dead-man switch in the guest** — systemd timer self-terminates the instance after 10 min without a broker heartbeat (IAM scoped to self-terminate only). Survives total control-plane loss.
4. **Reaper (60 s)** — `DescribeInstances` on `dfap:managed=true` left-joined against the DB; terminates anything expired or unknown for >15 min.
5. Guardrails — per-org concurrency caps, deliberately low vCPU quotas, AWS Budgets alarms, documented `panic --terminate-all`.

Weekly reconciliation diffs Cost Explorer against `SUM(usage_records.compute_cost_usd)`; variance is the measured leak rate.

## Data model (summary)

Postgres via Prisma — see [services/api/prisma/schema.prisma](../services/api/prisma/schema.prisma). Key tables: `orgs`, `users`, `workspace_templates`, `workspace_images` (AMI + snapshot SHA-256 per build), `pool_instances` (state machine incl. `expires_at` on every instance), `sessions` (incl. `first_pixel_at` — the headline SLI — and `end_reason`), `session_events` (append-only), `recordings` (WORM metadata, `legal_hold`), `audit_log` (hash-chained), `plans` / `subscriptions` / `usage_records` / `stripe_events` (idempotent webhooks via unique event id).

## Image pipeline

Packer builds from a vendor base AMI in an isolated build VPC → Ansible provisions → **offline hardening stage**: the stopped volume is snapshotted, attached to a hardening worker, and modified while not running (CIS remediation, redirection channels disabled, host keys stripped, dead-man unit injected) → re-snapshot → AMI registered with its SHA-256 recorded in `workspace_images`. 7-day rebuild cadence.

## Phase-0 deployment (current)

Everything on one `t4g.small` in Docker Compose: API, broker, guacd, single-node Vault (KMS auto-unseal), Postgres, Redis, Caddy for TLS. No NAT Gateway (VPC endpoints / NAT instance), no pool (cold launches), AWS Budget alarm at $50. Production topology (3-node Vault Raft, RDS, ElastiCache, guacd ASG) arrives with the first paying tenant.

## Protocol adapters

The broker consumes a `ProtocolAdapter` interface (`connect(sessionSpec) → duplex stream`). Guacamole/guacd is adapter #1, scoped to office/LOB workloads. NICE DCV (H.264/AV1, GPU) is the planned adapter #2 — the Guacamole wire protocol is tiled images, not video, and is unsuitable for motion-heavy work. See [adr/003](adr/003-guacd-plus-node-broker-over-java-webapp.md).
