#!/usr/bin/env bash
#
# DisFAP evaluation demo — (re)point RDP ingress at the demo host (SSH opt-in).
#
#   Run before the demo, and again if the demo host's egress IP rotates.
#
# The demo host's public IPv4 was observed to CHANGE within ~20 minutes
# (152.58.139.82 -> 152.58.163.53), which silently drops the readiness probe and
# the browser tunnel. Re-point the /32 rather than widening the rule:
#
#   CIDR=$(curl -s https://checkip.amazonaws.com)/32 bash scripts/demo/aws-allow-rdp.sh
#
# Do NOT widen to the ISP range or 0.0.0.0/0: RDP is exposed to one address.
# Note ec2:RevokeSecurityGroupIngress is denied to this role, so each re-point
# ADDS a rule that cannot be removed here.
#
# Opens tcp/3389 only. Set ALLOW_SSH=1 to also open tcp/22 (temporary debug path).
#
# Idempotent: re-adding an existing rule is treated as success.

set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-disfap}"
export AWS_REGION="${AWS_REGION:-ap-south-1}"

SG_NAME="${SG_NAME:-dfap-demo-sg}"
CIDR="${CIDR:?set CIDR to the current public IP of the demo host with /32 (see header)}"

SG_ID="$(aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=$SG_NAME" \
  --query 'SecurityGroups[0].GroupId' --output text)"
if [ -z "$SG_ID" ] || [ "$SG_ID" = "None" ]; then
  echo "security group $SG_NAME not found" >&2
  exit 1
fi

# RDP is the only port the demo needs. SSH 22 is the temporary in-guest
# log-reading path (runbook §7) and is opt-in, so it is never opened by accident.
PORTS=(3389)
if [ "${ALLOW_SSH:-0}" = "1" ]; then
  PORTS+=(22)
fi

for port in "${PORTS[@]}"; do
  if aws ec2 authorize-security-group-ingress \
       --group-id "$SG_ID" --protocol tcp --port "$port" --cidr "$CIDR" >/dev/null 2>&1; then
    echo "allowed tcp/$port from $CIDR"
  else
    echo "tcp/$port from $CIDR already present (or not permitted)"
  fi
done

echo "--- ingress now ---"
aws ec2 describe-security-groups --group-ids "$SG_ID" \
  --query 'SecurityGroups[0].IpPermissions[].{port:FromPort,ranges:IpRanges[].CidrIp}' --output json
