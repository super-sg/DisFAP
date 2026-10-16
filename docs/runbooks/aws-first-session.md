# Runbook: taking DisFAP onto real AWS

How to get from `CLOUD_PROVIDER=fake` (what runs today, offline) to session VMs
actually launching in *your* AWS account. Written against the infra in this repo
(`infra/terraform/phase0`, `infra/terraform/modules/session-fleet`,
`infra/packer`) and the control plane's `AwsCloudProvider`.

> Nothing here was ever executed: there is no AWS in the authoring environment.
> Treat every command as "review, then run", not copy-paste gospel.

---

## 0. Read this first: two different finish lines

There are two things you might mean by "do the AWS thing", and they cost very
different amounts of effort.

**Level A — prove the cloud plumbing.** The control plane really calls
`RunInstances` against a real launch template, tags the instance, and really
terminates it. This validates AWS integration, IAM, tagging, the reaper, the
dead-man switch wiring, and the budget guardrail. It does **not** give you a
working remote desktop, because the pieces below don't line up yet.

**Level B — a real pixel session.** guacd connects to a booted VM and you see a
desktop. This additionally requires the image↔template↔credential path to be
closed (see §7 "Known gaps"). That is more work and needs a decision from you.

Do Level A first. It is cheap to reason about and it de-risks everything after.

### Cost expectation (before you run anything)

`terraform apply` in `phase0` creates, at `us-east-1` list prices:

| Resource | ~Monthly |
|---|---|
| Control host `t4g.small` | ~$12 |
| Elastic IP (attached) | ~$3.65 |
| **7 interface VPC endpoints** (ssm, ssmmessages, ec2messages, kms, ecr.api, ecr.dkr, logs) | **~$51** (≈$7.3 each) |
| S3 recordings + KMS | a few $ |
| Session VMs (`t3.large`) | ~$0.083/hr each, only while running |

So budget **~$70/month idle**, plus sessions. A $50 budget alarm is wired in
(`budget_limit_usd = 50`), and the plan is to `terraform destroy` between tests.
The interface endpoints are the surprising line item — they exist because Phase-0
is a no-NAT topology.

---

## 1. Prerequisites

None of these are installed on the authoring machine — verify first:

```sh
for t in aws terraform packer session-manager-plugin; do
  printf '%-24s' "$t"; command -v "$t" >/dev/null && "$t" --version | head -1 || echo MISSING
done
```

Install on macOS:

```sh
brew install awscli terraform packer
brew install --cask session-manager-plugin   # only needed for SSM-reached Packer builds
```

The JS AWS SDK is already present (`node_modules/@aws-sdk/client-ec2`), so the
API needs no new dependency.

---

## 2. Credentials — the one rule that matters

**Do not put static AWS keys in `.env` on the control host.** Locally, use a
named profile; on EC2 the instance profile from Terraform is picked up
automatically by the SDK's default credential chain.

```sh
# Recommended: IAM Identity Center (SSO)
aws configure sso --profile disfap
export AWS_PROFILE=disfap
aws sts get-caller-identity        # proves it works

# Or a throwaway IAM user, if SSO isn't set up:
aws configure --profile disfap      # AdministratorAccess for the first apply
```

The first `terraform apply` needs broad rights (VPC, EC2, IAM, KMS, S3, budgets,
CloudWatch). After that, the runtime needs almost nothing: `phase0/main.tf`
attaches the fleet's pool-manager policy to the control host, so once deployed the
control plane manages instances using its **instance role**, not your keys.

---

## 3. Get a session AMI

`session_ami_id` has no default on purpose — a wrong image is a security hole.

**Level A fast path (recommended first):** use a stock Ubuntu 24.04 x86_64 AMI
(the launch template default is `t3.large`, x86_64). This image is **not
hardened** — use a throwaway account, and never for a real tenant.

```sh
aws ssm get-parameters \
  --names /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --query 'Parameters[0].Value' --output text
```

**The real path (Level B):** build the hardened image with Packer. Two stages,
per `infra/packer/README.md`:

```sh
cd infra/packer
cp example.pkrvars.hcl my.auto.pkrvars.hcl   # fill vpc_id, subnet_id, iam_instance_profile
packer init . && packer validate -var-file=my.auto.pkrvars.hcl .
packer build -var="git_commit=$(git rev-parse HEAD)" .
# → staging AMI (dfap:hardened=false — must NOT be launched into a session)
```

then the offline hardening stage **on a hardening-worker EC2**
(`infra/packer/offline-harden/README.md`) to produce the final
`dfap:hardened=true` AMI plus `out/workspace_image-<ami>.json`.

Packer needs an **isolated build VPC/subnet** and an instance profile carrying
`AmazonSSMManagedInstanceCore`. That build network is not created by `phase0`
(which builds the *session* VPC). Simplest first time: create a small build VPC
by hand, or point Packer at a non-session subnet in an existing dev VPC.

> The offline-harden stage is the product's differentiator and is the fiddliest
> part of the whole pipeline (nested EC2 + `virt-customize`). It is fine to defer
> it behind Level A.

---

## 4. Apply the infrastructure

```sh
cd infra/terraform/phase0
cp terraform.tfvars.example terraform.tfvars
# edit: aws_region, session_ami_id, budget_notification_email
terraform init
terraform plan      # READ IT — you are creating a VPC, endpoints, IAM, a host
terraform apply
```

Outputs you will need:

```
control_host_public_ip      -> where the web app will live
session_launch_template_id  -> goes into AWS_LAUNCH_TEMPLATE_ID
session_template_sg_id      -> the pool manager clones this per session
```

The control host has **no security-group ingress on port 22** and **no
`user_data`**, so it comes up bare and is administered over SSM Session Manager:

```sh
aws ssm start-session --target "$(terraform output -raw control_host_instance_id)"
```

You then deploy the stack (`deploy/`) onto it yourself; there is no bootstrap step
in Terraform today.

---

## 5. Point the control plane at AWS

On the control host (or locally, for a Level-A-only test), in the API's
environment:

```sh
CLOUD_PROVIDER=aws
AWS_REGION=us-east-1
AWS_LAUNCH_TEMPLATE_ID=lt-xxxxxxxxxxxxxxxxx
# AWS_LAUNCH_TEMPLATE_VERSION=1        # optional pin; omit for $Latest
```

`services/api/src/config.ts` requires `AWS_REGION` and `AWS_LAUNCH_TEMPLATE_ID`
whenever `CLOUD_PROVIDER=aws` and refuses to boot without them. No AWS keys are
read by the app — only the default credential chain (the host's instance role).

Also required for the marketplace work delivered alongside this runbook:

```sh
DFAP_PAIR_MASTER_KEY=$(openssl rand -base64 32)   # production-grade pair-key master
# plus DATABASE_URL + the Prisma migration (npx prisma migrate deploy)
```

---

## 6. Verify

```sh
# Health
curl -s http://<control_host_public_ip>/healthz

# Rent a license (this calls RunInstances)
curl -s -X POST http://<control_host_public_ip>/api/marketplace/rent \
  -H 'content-type: application/json' \
  -H 'x-dfap-user: usr_dev' -H 'x-dfap-org: org_dev' \
  -d '{"licenseId":"lic_matlab_2024","hoursRequested":1}'

# The instance must exist, be tagged, and have NO public IP:
aws ec2 describe-instances \
  --filters Name=tag:dfap:managed,Values=true \
  --query 'Reservations[].Instances[].{Id:InstanceId,State:State.Name,IP:PrivateIpAddress,Expires:Tags[?Key==`dfap:expires_at`].Value|[0]}'
```

Then confirm teardown works, because that is the safety-critical part:

1. End the session → instance goes to `terminated`, EBS volume gone.
2. **Kill the API mid-session**, wait past `dfap:expires_at`, and confirm the
   reaper (or the in-guest dead-man switch, with the hardened image) terminates
   the instance anyway.

```sh
terraform destroy    # when done. Note: the recordings bucket has Object Lock
                     # COMPLIANCE retention — destroy will refuse if objects are held.
```

---

## 7. Known gaps before a working pixel session (Level B)

Be aware these are not yet closed. They are design seams, not mysteries:

| Gap | Detail |
|---|---|
| **OS mismatch** | The Packer image is **Linux** (Ubuntu 24.04 + xrdp + a locked `session` user). The marketplace seeds/templates are **Windows** (`tmpl_win_rdp`). A Linux session needs a Linux workspace template + marketplace entry. |
| **In-guest credential path** | The Packer README says the control plane "sets a per-session password via SSM at claim time", but no code issues that SSM command yet. The new pre-boot injector seals a blob expecting an in-image `dfap-preboot.service` to unseal it — that unit does not exist yet. So the `session` user cannot log in. |
| **Vault** | The guacd credential handshake needs a reachable, unsealed Vault (`HttpVaultClient`); Phase-0 compose has one, a local-only test does not. |
| **Packer build network** | Not provisioned by `phase0`; see §3. |

Recommended resolution order: (1) Level A plumbing test with a stock Ubuntu AMI,
(2) add the `dfap-preboot.service` unit + a Linux RDP workspace template, (3) run
the full Packer build, (4) wire Vault, (5) end-to-end pixels.

---

## 8. Decision needed from the owner

**Windows or Linux session VMs?** The isolation work and the Packer pipeline are
Linux. The demo catalog is Windows. This choice determines whether we align the
catalog to the Linux image (recommended — less new work, matches the hardened
pipeline) or commit to a Windows image path (new Packer template, offline SAM/cred
provisioning).

## What the assistant needs from you

- AWS account id + region, and whether the account is **throwaway**.
- The profile name you configured (`AWS_PROFILE=...`), or confirmation you'd
  rather run `terraform`/`packer` yourself and paste the output.
- Budget-alarm email.
- The Windows/Linux decision above.
- Which finish line: Level A only for now, or straight to Level B?
