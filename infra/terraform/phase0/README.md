# DisFAP — Phase-0 Terraform

The cheapest possible DisFAP footprint: **one `t4g.small` control host** running the
entire docker-compose stack (web + broker + guacd), plus the reusable
[`session-fleet`](../modules/session-fleet) module wired for **no NAT Gateway** and
**cold-launch** sessions. There is no warm pool and no NAT — both are later
optimizations (ADR-001), not prerequisites.

## What this creates

| Resource | Why |
|---|---|
| VPC, 2 public + 2 private subnets, IGW | Fleet network. **No NAT Gateway.** |
| VPC interface endpoints (ssm, ssmmessages, ec2messages, kms, ecr.api, ecr.dkr, logs) + S3 gateway endpoint | The NAT-free path to AWS for private instances |
| guacd host SG + per-session SG **template** | Tenant isolation: session VMs accept RDP **only** from guacd; egress default-deny |
| Launch template for session VMs | Declarative VM spec; the pool manager (not Terraform) calls `RunInstances` |
| Instance role with **self-terminate** rights | Guest-side dead-man switch |
| Pool-manager role + policy | Least-priv control-plane rights (attached to the control host) |
| Object-Lock (COMPLIANCE) recordings bucket + CMK | Tamper-evident session recordings |
| `$50` monthly budget alarm | Phase-0 cost guardrail |
| `t4g.small` control host + Elastic IP | Public entrypoint running the stack |

## Cost posture

- **No NAT Gateway** (~$32/mo + per-GB saved). Private egress to AWS goes through
  VPC endpoints; general internet egress from session VMs is simply not available
  (correct for pixel-only). A `t4g.nano` NAT *instance* can be toggled on in the
  module if ever needed (`enable_nat_instance`), but Phase-0 leaves it off.
- **Cold launch** every session — zero idle pool cost.
- **$50 budget alarm** emails you at 80% forecast and 100% actual.

## Prerequisites

- Terraform >= 1.5, AWS provider ~> 5.x (pinned in `versions.tf`).
- AWS credentials with rights to create the above (an admin/bootstrap principal).
- A hardened session AMI ID (built by `infra/packer`).

## Usage

```bash
cd infra/terraform/phase0

# 1. Provide your inputs (this file is gitignored; the .example is not).
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars      # set session_ami_id + budget_notification_email

# 2. Initialize providers (and the S3 backend, once you enable it).
terraform init

# 3. Review the plan.
terraform plan

# 4. Apply.
terraform apply
```

Outputs include `control_host_public_ip` (point DNS here) and
`session_launch_template_id` (hand to the pool manager).

## State & secrets are gitignored

`*.tfstate`, `*.tfstate.backup`, `*.tfvars`, and `.terraform/` are all ignored by the
repo `.gitignore` — state can contain sensitive values and **must not be committed**.
Only `terraform.tfvars.example` and the `*.tf` sources are tracked.

For anything beyond a single laptop, enable the **S3 + DynamoDB remote backend**: an
example `backend "s3"` block is commented at the bottom of `versions.tf`. Create the
bucket (versioned, SSE-KMS, private) and the lock table (`LockID` string PK) once, then
uncomment the block and run `terraform init -migrate-state`.

## Teardown

```bash
terraform destroy
```

Note: the recordings bucket has `force_destroy = false` and **Object Lock in
COMPLIANCE mode** — locked object versions cannot be deleted until their retention
expires, so `destroy` will refuse to remove the bucket while any are held. That is
intentional: audit evidence is not casually destroyable.
