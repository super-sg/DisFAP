# DisFAP — local-evaluation demo (real EC2, single happy path)

**Status: prepared, NOT executed.** Nothing in the "AWS setup / teardown" sections
has been run. No EC2 resource has been created, started, stopped, or terminated.
AWS calls made while preparing this document were **read-only**.

This runbook is the shortest reliable path to the required demonstration:

1. An owner publishes a Linux software listing with a **dedicated demo credential**.
2. A renter selects the listing and clicks **Rent & Launch**.
3. DisFAP launches a **real EC2 instance** (Ubuntu + XFCE over xrdp).
4. The UI shows **truthful** provisioning/readiness progress (never a fabricated `ready`).
5. The real desktop appears in the browser via Caddy→broker→guacd→xrdp→Guacamole.
6. Ending the session **terminates the instance**, revokes the credential, and
   releases the rental.

---

## 0. Topology (why this shape)

| Piece | Where | Why |
|---|---|---|
| Control plane (API) | **Local Mac** (`services/api`) | no control-host EC2, no VPC endpoints, $0 |
| Broker + guacd | **Local Mac** | reaches the session VM's public IP directly |
| Session VM | **EC2, default VPC, public subnet, public IPv4** | the local control plane is *outside* the VPC, so a private IP is unreachable |
| Credential delivery (eval) | EC2 **userData** (`CloudInitInjector`) | stock AMI, no golden image; **documented deviation** — see §7 |
| Readiness | `pool/readiness.ts` (local loop) | `ready` only when AWS says `running` **and** TCP 3389 accepts |

The shipped `infra/terraform/phase0` fleet is deliberately **not** used here: it
builds private subnets, interface VPC endpoints, a control host, and a 60 GiB
root — a correct production shape, but the wrong one for a < $20 experiment.

---

## 1. Prerequisites (no secrets are pasted anywhere)

- AWS CLI profile `disfap` (IAM Identity Center) already configured — **do not
  reconfigure**. The API uses the default credential chain; it never takes keys
  on the command line. Refresh it immediately before the demo:
  `aws sso login --profile disfap`.
- Docker Desktop running (for `guacd` only). No container is exposed publicly;
  guacd is bound to `127.0.0.1:4822`.
- Postgres (local, e.g. Postgres.app) with role/database `disfap`.
- Node 24 (repo toolchain).

Environment for the API (`.env` at the repo root, gitignored). **Fill in the
blank IDs yourself after §4; never commit them:**

```dotenv
DFAP_ENV=development
DATABASE_URL=postgresql://<user>@localhost:5432/disfap?schema=public
DFAP_AUTH_MODE=dev-header
DFAP_CORS_ALLOWED_ORIGINS=http://localhost:5173
DFAP_SIGNING_KEYS=kdev:<32-byte-base64-key>
DFAP_SIGNING_KID=kdev

# Base URL ONLY — the browser appends /tunnel (apps/web/src/session/dfap-tunnel.ts).
BROKER_URL=ws://localhost:8080
BROKER_WS_PATH=/tunnel
GUACD_HOST=127.0.0.1
GUACD_PORT=4822

# Real cloud
CLOUD_PROVIDER=aws
AWS_REGION=ap-south-1
AWS_LAUNCH_TEMPLATE_ID=lt-...        # from §4
AWS_SESSION_AMI_ID=ami-...           # the SAME AMI the launch template uses
AWS_SESSION_INSTANCE_TYPE=t4g.small
AWS_SESSION_ARCHITECTURE=arm64
AWS_PROFILE=disfap
```

> The API refuses to start on `CLOUD_PROVIDER=aws` without a real
> `AWS_SESSION_AMI_ID` (a placeholder or an instance/architecture mismatch is a
> hard config error), so a misconfiguration fails loudly instead of launching a
> wrong or unusable VM.

---

## 2. Local database (executed during development, reproducible)

```bash
cd services/api
npx prisma migrate deploy
DATABASE_URL=... node ../../scripts/demo/seed.mjs
```

`scripts/demo/seed.mjs` is idempotent and creates **only** what the demo needs:
org `org_dev`, user `usr_dev` (owner), an active plan + subscription (without it
`enforceQuota` refuses to spend money), and the `tmpl_linux_dev` /
`tmpl_win_rdp` templates. It never creates listings — the owner flow does.

---

## 3. Local services

```bash
# One-time build (API + broker + Prisma client)
npm run build

# guacd (Guacamole protocol ↔ RDP translator). Local only.
docker run --rm -d --name dfap-guacd -p 127.0.0.1:4822:4822 guacamole/guacd:1.6.0

# Optional: apply the additive migrations and seed the two demo identities.
cd services/api
npx prisma migrate deploy
cd ../..
DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)" node scripts/demo/seed.mjs

# Control plane + in-process broker + Vite UI (loads .env)
npm start
```

Equivalent separate processes:

```bash
node services/api/dist/server.js
npm run dev --workspace=@disfap/web
```

---

## 4. AWS disposable topology

Prefer the scripts — they encode everything learned from a real launch:

```bash
export AWS_PROFILE=disfap AWS_REGION=ap-south-1
# IAM Identity Center access tokens here last only ~1 hour. Refresh first.
aws sso login --profile disfap

# Security group + launch template (no instance; $0 to create).
# /32 = the demo host's CURRENT public IPv4. Never 0.0.0.0/0, and not the whole
# ISP range: RDP is exposed to exactly one address.
DEMO_IP=<this host's public IPv4>/32 bash scripts/demo/aws-setup.sh
# The demo host's public IPv4 rotates (observed: 152.58.139.82 -> 152.58.163.53
# in ~20 min), which silently breaks both the readiness probe and the tunnel.
# Re-point the /32 before the demo and again if either starts failing:
CIDR=$(curl -s https://checkip.amazonaws.com)/32 bash scripts/demo/aws-allow-rdp.sh
```

**Facts verified against the live account (not assumed):**

- `ssm:GetParameters` is **denied** by the `DisFAP-Demo` permission set, so the
  Canonical SSM parameter path below does **not** work. Resolve the AMI with
  `ec2:DescribeImages` (owner `099720109477`): `ami-0d9154058422475a4`
  (`ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-20261004`).
- The AMI root device is **`/dev/sda1`** — exactly what
  `buildRunInstancesInput` sends, so that earlier concern is closed.
- **The demo host's public IPv4 is not stable**: it changed from
  `152.58.139.82` to `152.58.163.53` inside ~20 minutes. A stale `/32` rule
  silently drops the readiness probe *and* the browser tunnel, so **re-point the
  `/32` before the demo and again if either starts failing** — do **not** widen to
  the ISP range or `0.0.0.0/0`. Be aware that `ec2:RevokeSecurityGroupIngress` is
  **denied** to `DisFAP-Demo`, so each re-point ADDS a rule that the policy will
  not let us remove: expect the group to accumulate a few `/32`s (each still a
  single address) and ask the account admin to prune them, or to grant `Revoke`.
- Also denied (don't plan around them): `ec2:DescribeRouteTables`,
  `ec2:DescribeInternetGateways`, `ec2:DescribeNetworkAcls`,
  `ec2:DescribeInstanceStatus`, `ec2:GetConsoleOutput`,
  `ec2:DescribeInstanceTypeOfferings`, `iam:ListInstanceProfiles`.

<details>
<summary>Equivalent raw commands</summary>

Create **one** security group and **one** launch template in the default VPC.
Replace `<MY_EGRESS_IP>` with the demo machine's public IP (e.g.
`curl -s https://checkip.amazonaws.com`) — **never `0.0.0.0/0`**.

```bash
export AWS_PROFILE=disfap AWS_REGION=ap-south-1
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
SUBNET=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC \
  --query 'Subnets[?MapPublicIpOnLaunch==`true`]|[0].SubnetId' --output text)

# Stock Ubuntu 24.04 LTS ARM64 (free public AMI — resolved read-only)
AMI=$(aws ssm get-parameters \
  --names /aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id \
  --query 'Parameters[0].Value' --output text)

SG=$(aws ec2 create-security-group --group-name dfap-demo-sg \
  --description "DisFAP eval: RDP from demo host only" --vpc-id $VPC \
  --tag-specifications 'ResourceType=security-group,Tags=[{Key=dfap:managed,Value=true}]' \
  --query GroupId --output text)

# RDP from the demo host ONLY. (Add 22/tcp the same way only if you need SSH.)
aws ec2 authorize-security-group-ingress --group-id $SG \
  --protocol tcp --port 3389 --cidr <MY_EGRESS_IP>/32

# Launch template: public subnet, public IPv4, IMDSv2-only, encrypted root,
# delete-on-terminate, dfap tags. The API no longer sends top-level
# SecurityGroupIds (the launch template owns the ENI), so the SG lives here.
LT=$(aws ec2 create-launch-template --launch-template-name dfap-demo-lt \
  --launch-template-data "{
    \"ImageId\": \"$AMI\",
    \"InstanceType\": \"t4g.small\",
    \"NetworkInterfaces\": [{
      \"DeviceIndex\": 0,
      \"SubnetId\": \"$SUBNET\",
      \"AssociatePublicIpAddress\": true,
      \"Groups\": [\"$SG\"]
    }],
    \"MetadataOptions\": {\"HttpTokens\": \"required\", \"HttpEndpoint\": \"enabled\"},
    \"BlockDeviceMappings\": [{
      \"DeviceName\": \"/dev/sda1\",
      \"Ebs\": {\"VolumeSize\": 30, \"VolumeType\": \"gp3\", \"DeleteOnTermination\": true, \"Encrypted\": true}
    }],
    \"TagSpecifications\": [{\"ResourceType\": \"instance\", \"Tags\": [{\"Key\": \"dfap:managed\", \"Value\": \"true\"}]}]
  }" --query 'LaunchTemplate.LaunchTemplateId' --output text)

echo "AWS_LAUNCH_TEMPLATE_ID=$LT"
echo "AWS_SESSION_AMI_ID=$AMI"
```

</details>

Put `$LT` / `$AMI` into `.env`, restart the API, then run the demo (§6).

### Teardown

Prefer `bash scripts/demo/aws-teardown.sh` — it terminates only
`tag:dfap:managed=true` instances, then deletes the launch template and the
security group. Raw equivalent:

```bash
export AWS_PROFILE=disfap AWS_REGION=ap-south-1
# Terminate ONLY DisFAP-tagged instances (never a blanket terminate).
aws ec2 describe-instances --filters 'Name=tag:dfap:managed,Values=true' \
  'Name=instance-state-name,Values=pending,running,stopping,stopped' \
  --query 'Reservations[].Instances[].InstanceId' --output text \
  | xargs -r -n1 aws ec2 terminate-instances --instance-ids
aws ec2 delete-launch-template --launch-template-name dfap-demo-lt
aws ec2 delete-security-group --group-name dfap-demo-sg   # after instances are gone
```

The session EBS volume has `DeleteOnTermination: true`, so nothing is retained.
No snapshots, no EIP, no S3, no ALB, no NAT, no VPC endpoints are created.

### Local data cleanup (optional, after the demo)

End every live session from the UI first; then remove only the listings created
for the demo (this also removes their rentals; it does not touch users, plans,
or templates):

```sql
-- run with: psql "$DATABASE_URL"
DELETE FROM license_rentals
 WHERE license_id IN (SELECT id FROM software_licenses WHERE software_name IN ('DisFAP Demo CAD', 'Demo Workstation (XTuple-like)'));
DELETE FROM software_licenses
 WHERE software_name IN ('DisFAP Demo CAD', 'Demo Workstation (XTuple-like)');
```

Stop local processes with `Ctrl-C` on `npm start`, and remove guacd:

```bash
docker rm -f dfap-guacd
```


---

## 5. Cost estimate (conservative, ap-south-1)

| Item | Rate | 2 h session | Note |
|---|---|---|---|
| EC2 `t4g.small` | ≈ $0.021/h | $0.04 | per-instance, billed by the second |
| EBS gp3 20 GiB | ≈ $0.096/GiB-mo | $0.006 | deleted on terminate |
| Public IPv4 | $0.005/h | $0.01 | in-use address |
| Data out (pixels) | ≈ $0.109/GB | ≤ $0.50 | RDP desktop is ~1–2 Mbps |
| SG / launch template / AMI | $0 | $0 | free |
| Local API/broker/guacd | $0 | $0 | on the demo Mac |

**≈ $0.56 for one session.** Even ten launches + retries stay **well under $20**.
The only way to approach the cap is to leave an instance running: the API stamps
a hard `expires_at` on every instance and the reaper terminates expired ones, and
the manual teardown above removes anything tagged `dfap:managed`.

> Budget alerts are not a hard cap. The teardown command is the real control.

---

## 6. The demo (owner + renter)

The local evaluation uses the loopback-only dev identity adapter. The API now
binds `127.0.0.1` when `DFAP_AUTH_MODE=dev-header`, so these identities cannot
be asserted from another machine. Two browser windows are two independent
principals, seeded by `scripts/demo/seed.mjs`:

| Window | URL | Principal | Role |
|---|---|---|---|
| Browser A (owner) | `http://localhost:5173/?as=owner` | `usr_owner` / Alex Owner | owner |
| Browser B (renter) | `http://localhost:5173/?as=renter` | `usr_renter` / Riley Renter | member |

If a window has no `?as=` parameter it shows the local demonstration sign-in
gate; choose the person there. `Switch` in the navbar returns to that gate.
No password is entered or stored by this local gate.

1. **Owner** opens the owner URL. The nav shows *Owner Dashboard*; it is backed
   by `GET /api/marketplace/licenses/mine`. Open *Workspaces* → *List Software
   (Owner)*, fill in the name/description/category/demo username/password and
   access duration, then press **Publish Listing**. The credential is sealed by
   the HSM before persistence; the success panel shows the listing id.
2. **Renter** opens the renter URL (or refreshes it) → *Workspaces* → *Software
   Licenses*. The listing is read from the database, not the frontend; it shows
   the owner, availability, hourly rate, and access limit. Press **Use Software**.
3. The screen shows **Provisioning workspace → Preparing secure session →
   Connecting to remote desktop**, driven by `GET /api/sessions/:id`. It only
   advances past "preparing" when `pool/readiness.ts` confirms AWS reports
   `running` **and** TCP 3389 accepts. Cold start (apt install of XFCE/xrdp) is
   typically **3–8 minutes**.
4. When ready, the browser opens the Guacamole canvas and the **real XFCE
   desktop** is rendered as pixels. The demo window (`dfap-demo-app.py`) is
   already open; click its button to prove mouse input and watch the guest clock
   update to prove the pixels are live.
5. **End Session** → the instance is terminated, the Vault credential revoked,
   the rental released, and usage/audit rows written exactly once.

> **Credential semantics (do not overclaim).** The submitted owner credential is
> the **disposable Linux OS account** created on the throwaway VM by the
> evaluation injector. It is not a third-party application login. The desktop
> application is a purpose-built DisFAP demo (`dfap-demo-app.py`) that performs
> no authentication. The evaluation demonstrates brokered, credential-free
> remote access to a real interactive desktop; it does not claim arbitrary
> commercial-software SSO.


---

## 7. Honest limitations and the one security deviation

- **Credential-in-userData (evaluation only).** With a stock AMI and the control
  plane outside the VPC there is no in-guest provisioning unit, so the
  `CloudInitInjector` renders a `#cloud-config` that creates the demo account and
  installs XFCE/xrdp. The credential therefore rides in EC2 userData, readable by
  anyone with `ec2:DescribeInstanceAttribute` in the account. This is **gated**:
  the injector refuses any credential not explicitly declared `demoOnly`, refuses
  a production config, and is selected only for `CLOUD_PROVIDER=aws` in a
  non-production env. **Production keeps the verified-instance-identity pull
  path** (`guest/guest-provisioning.ts`, M8) and never puts login material in
  userData.
  - Missing component for the safe eval path: the guest has **no route to the
    control plane** (it runs on the Mac), so the M8 pull cannot be used as-is.
    Smallest remedy: deliver the one-time credential via an **SSM `SecureString`
    parameter** (instance profile + `ssm:GetParameter`), or run the existing pull
    endpoint on an in-VPC control host.
- **Reconnect is bounded.** The broker consumes the Vault wrap token read-once,
  so a page refresh or network drop needs a fresh `GET /api/sessions/:id` handle
  (the client re-polls automatically). The persisted grace deadline
  (`sessions.disconnect_deadline_at`) bounds how long the VM survives an
  abandoned tab; a hard refresh while disconnected may still lose the session
  after that window, but a normal drop reconnects with a fresh single-use handle.
- **No real third-party app.** The desktop carries a clearly labelled
  **DisFAP demo application** (`dfap-demo-app.py`, Tkinter, auto-started in the
  XFCE session) that proves the session is live and interactive. It is *not* the
  owner's software and authenticates nothing; the owner's credential is not used
  to launch or log in to any commercial application, and no such claim is made.
- **No TLS/DNS in the local demo.** The browser and broker are on the same host
  (`ws://localhost`), so Caddy/HTTPS is not required. A real domain deployment
  would need Caddy + DNS + WSS.
- **Temporary SSH debug path (evaluation only).** Setting `DFAP_EVAL_SSH_PUBKEY`
  adds a *public* key (not a secret) to the stock `ubuntu` user so the operator
  can read cloud-init logs on a stock AMI. It is inert unless the SG also allows
  22/tcp, and the injector still refuses to render for production. Remove the SG
  rule when the demo ends.

---

## 8. What a real launch actually revealed (verified)

Two defects were found by reading `/var/log/cloud-init-output.log` on a live
instance — neither was visible from the control plane, and both are now fixed:

1. **cloud-init prefixes its generated `runcmd` script with `#!/bin/sh`.** An
   inline multi-line installer therefore executed under **dash** and died on
   `set -o pipefail` (`set: Illegal option -o pipefail`), so the desktop install
   never ran at all and 3389 never opened. Fixed by shipping the installer as a
   file and invoking it explicitly: `runcmd: [bash, /usr/local/bin/dfap-install-desktop.sh, <user>]`.
2. **`write_files` owned by the demo account failed** with
   `Unknown user or group: 'dfapsmoke'`. Per-user files are now created by the
   installer, after the account exists, instead of by `write_files`.

Also confirmed on the live box: apt and outbound networking work; the dpkg lock
held by first-boot `unattended-upgrades` is waited out; `xrdp` listens on 3389;
and `python3 -c 'import tkinter'` succeeds. With those fixes the exact same
commands brought a real XFCE desktop up over xrdp.

**Operational gotchas that will bite during a demo:**

- **IAM Identity Center tokens here last ~1 hour.** Run
  `aws sso login --profile disfap` immediately before the demo. If the token
  lapses mid-session the readiness loop logs `CredentialsProviderError` and the
  session simply stays `allocating` (it never fakes `ready`); it recovers on the
  next pass after re-login.
- **The demo host's public IPv4 rotates**, so keep the SG scoped to the ISP
  range rather than a `/32` (see §4).

