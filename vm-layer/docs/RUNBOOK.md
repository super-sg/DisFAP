# Operational Runbook — VM Layer

## Table of Contents

1. [Building a New AMI](#1-building-a-new-ami)
2. [Deploying Infrastructure Changes](#2-deploying-infrastructure-changes)
3. [Managing the VM Manager Service](#3-managing-the-vm-manager-service)
4. [Investigating a Stuck VM](#4-investigating-a-stuck-vm)
5. [Emergency Cleanup](#5-emergency-cleanup)
6. [Monitoring & Alerting](#6-monitoring--alerting)
7. [Troubleshooting](#7-troubleshooting)

---

## 1. Building a New AMI

### When to Rebuild

- Software updates (new version of Adobe, CAD, etc.)
- Security patches for the OS
- Changes to VM configuration (RDP settings, user permissions)

### Steps

```bash
# 1. Update the Packer template or scripts as needed
# 2. Validate the template
make validate-packer

# 3. Build the image
make build-image-windows   # For Windows
make build-image-linux     # For Linux

# 4. Note the new AMI ID from the output
# 5. Update the .env or SSM parameter with the new AMI ID
# 6. Test with a single session before rolling out
```

### Rollback

If a new AMI causes issues, revert to the previous AMI ID in your `.env` or SSM parameter. Old AMIs are preserved in your AWS account until manually deregistered.

---

## 2. Deploying Infrastructure Changes

### Standard Deployment

```bash
# 1. Make changes to Terraform modules
# 2. Format
make fmt

# 3. Validate
make validate-terraform

# 4. Plan (review carefully!)
make plan ENV=dev
# Review the plan output — ensure no unexpected destroys

# 5. Apply
make apply ENV=dev

# 6. Verify outputs
cd terraform/environments/dev && terraform output
```

### Production Deployment

```bash
# Same steps but with ENV=prod
make plan ENV=prod
# ALWAYS review the plan for production
# Get team approval before applying
make apply ENV=prod
```

### Dangerous Operations

> ⚠️ **Never run `terraform destroy` in production without explicit approval.**

If you need to destroy specific resources, use `-target`:

```bash
cd terraform/environments/prod
terraform destroy -target=module.networking.aws_nat_gateway.nat
```

---

## 3. Managing the VM Manager Service

### Starting / Stopping

```bash
# Development (with auto-reload)
make start-dev

# Production
make start

# Stop: Ctrl+C or send SIGTERM
kill -SIGTERM $(pgrep -f "node src/index.js")
```

### Health Check

```bash
curl http://localhost:3001/api/vm/health
```

Expected response:
```json
{
  "success": true,
  "service": "vm-manager",
  "status": "healthy",
  "uptime": 3600,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

---

## 4. Investigating a Stuck VM

### Symptoms

- Session status stuck at "provisioning"
- VM Manager logs show repeated health check failures
- User reports they can't connect

### Investigation Steps

```bash
# 1. Check the session status
curl http://localhost:3001/api/vm/<sessionId>/status

# 2. Check the EC2 instance directly
aws ec2 describe-instances --instance-ids <instanceId> \
  --query 'Reservations[0].Instances[0].{State:State.Name,IP:PrivateIpAddress}'

# 3. Check instance system logs (UserData output)
aws ec2 get-console-output --instance-id <instanceId> --output text

# 4. Check if the instance is reachable from Guacamole
# SSH into the Guacamole server and test:
telnet <private-ip> 3389    # For Windows (RDP)
telnet <private-ip> 5901    # For Linux (VNC)

# 5. Check security group rules
aws ec2 describe-security-groups --group-ids <sg-id>
```

### Common Causes

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Instance stuck in 'pending' | AMI issue or capacity | Try different AZ |
| Instance running, can't connect | Security group misconfigured | Check SG rules |
| RDP works, Guacamole doesn't | NLA not disabled | Rebuild AMI |
| VNC black screen | XFCE not starting | Check VNC xstartup |
| UserData didn't run | Script error | Check console output |

---

## 5. Emergency Cleanup

### Kill All Session VMs

If you need to terminate all session VMs immediately:

```bash
# Find all session VMs
aws ec2 describe-instances \
  --filters "Name=tag:Project,Values=software-sharing" \
            "Name=tag:AutoDestroy,Values=true" \
            "Name=instance-state-name,Values=running,stopped,pending" \
  --query 'Reservations[*].Instances[*].InstanceId' \
  --output text

# Terminate all found instances
aws ec2 terminate-instances --instance-ids <list-of-ids>
```

### Nuclear Option: Terraform Destroy

```bash
# CAUTION: This destroys ALL infrastructure including networking
make destroy ENV=dev
```

### Cost Emergency

If you suspect runaway costs:

1. Check the AWS Cost Explorer for EC2 spend
2. Run the emergency cleanup above
3. Check for orphaned EBS volumes:
   ```bash
   aws ec2 describe-volumes \
     --filters "Name=tag:Project,Values=software-sharing" \
               "Name=status,Values=available" \
     --query 'Volumes[*].VolumeId'
   ```
4. Delete any orphaned volumes:
   ```bash
   aws ec2 delete-volume --volume-id <vol-id>
   ```

---

## 6. Monitoring & Alerting

### Key Metrics to Watch

| Metric | Source | Alert Threshold |
|--------|--------|----------------|
| Active session count | VM Manager logs | > 20 |
| Provisioning time | VM Manager logs | > 120 seconds |
| Failed provisions | VM Manager logs | > 3 in 5 minutes |
| Orphaned VM count | Reaper logs | > 0 |
| EC2 spend | AWS Cost Explorer | > daily budget |

### CloudWatch Log Groups

- `/software-sharing/vm-manager` — API and lifecycle logs
- `/software-sharing/session-vms` — Per-VM logs (CloudWatch Agent)

### Recommended Alerts

```bash
# Set up a CloudWatch alarm for high EC2 instance count
aws cloudwatch put-metric-alarm \
  --alarm-name "software-sharing-high-vm-count" \
  --metric-name "ActiveInstances" \
  --namespace "SoftwareSharing" \
  --threshold 20 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 1 \
  --period 300 \
  --statistic Maximum \
  --alarm-actions <sns-topic-arn>
```

---

## 7. Troubleshooting

### "Guacamole token creation failed: 403"

**Cause:** The HMAC secret key doesn't match between VM Manager and Guacamole.

**Fix:** Ensure `GUACAMOLE_SECRET_KEY` in `.env` matches the `json-secret-key` in Guacamole's `guacamole.properties`.

### "Maximum concurrent VMs reached"

**Cause:** User has hit the `MAX_CONCURRENT_VMS` limit.

**Fix:** Either increase the limit or have the user destroy existing sessions.

### "No AMI configured for OS type"

**Cause:** `WINDOWS_AMI_ID` or `LINUX_AMI_ID` not set in `.env`.

**Fix:** Run a Packer build and update the `.env` with the new AMI ID.

### "Instance terminated unexpectedly"

**Cause:** Spot Instance was reclaimed, or instance failed health check.

**Fix:** Check CloudTrail for the termination event. Consider using On-Demand for stability.

### Terraform State Lock

```bash
# If Terraform is stuck on a state lock:
cd terraform/environments/<env>
terraform force-unlock <lock-id>
```
