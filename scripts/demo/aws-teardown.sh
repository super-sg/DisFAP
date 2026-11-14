#!/usr/bin/env bash
#
# DisFAP evaluation demo — AWS TEARDOWN (removes everything this demo created).
#
#   NOT executed by the agent. Run when the demo is over.
#
# Terminates ONLY instances tagged `dfap:managed=true` (the tag DisFAP applies on
# create), then deletes the demo launch template and security group. It never
# touches the default security group or any un-tagged instance.
#
# Usage:
#   AWS_PROFILE=disfap AWS_REGION=ap-south-1 bash scripts/demo/aws-teardown.sh

set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-disfap}"
export AWS_REGION="${AWS_REGION:-ap-south-1}"

SG_NAME="${SG_NAME:-dfap-demo-sg}"
LT_NAME="${LT_NAME:-dfap-demo-lt}"

# --- 1. Terminate every DisFAP-managed instance -----------------------------
IDS="$(aws ec2 describe-instances \
  --filters "Name=tag:dfap:managed,Values=true" \
            "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text)"
if [ -n "$IDS" ]; then
  echo "terminating: $IDS"
  aws ec2 terminate-instances --instance-ids $IDS >/dev/null
  aws ec2 wait instance-terminated --instance-ids $IDS
  echo "terminated"
else
  echo "no running DisFAP-managed instances"
fi

# --- 2. Delete the launch template ------------------------------------------
LT_ID="$(aws ec2 describe-launch-templates \
  --filters "Name=launch-template-name,Values=$LT_NAME" \
  --query 'LaunchTemplates[0].LaunchTemplateId' --output text 2>/dev/null || true)"
if [ -n "$LT_ID" ] && [ "$LT_ID" != "None" ]; then
  aws ec2 delete-launch-template --launch-template-id "$LT_ID"
  echo "deleted launch template $LT_ID"
fi

# --- 3. Delete the security group -------------------------------------------
SG_ID="$(aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=$SG_NAME" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)"
if [ -n "$SG_ID" ] && [ "$SG_ID" != "None" ]; then
  aws ec2 delete-security-group --group-id "$SG_ID"
  echo "deleted security group $SG_ID"
fi

echo "teardown complete"
