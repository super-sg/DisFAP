#!/usr/bin/env bash
#
# DisFAP evaluation demo — AWS SETUP (creates 1 security group + 1 launch template).
#
#   NOT executed by the agent. Run only after explicit approval.
#   This creates NO instance: the instance is launched by DisFAP when the renter
#   clicks "Launch".
#
# Cost: $0 to create. The first launch bills t4g.small (~$0.021/hr) + 20 GiB gp3
# (~$0.0016/hr) + public IPv4 (~$0.005/hr).
#
# Safety: RDP (3389) is opened ONLY to the demo host's egress IP /32 — never
# 0.0.0.0/0. No key pair, no IAM role, no NAT, no load balancer.
#
# Usage:
#   AWS_PROFILE=disfap AWS_REGION=ap-south-1 DEMO_IP=1.2.3.4/32 bash scripts/demo/aws-setup.sh

set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-disfap}"
export AWS_REGION="${AWS_REGION:-ap-south-1}"

VPC="${VPC:-vpc-06228e83747ad93fa}"
SUBNET="${SUBNET:-subnet-0baa6db9394fc8c7e}"      # ap-south-1b, public
AMI="${AMI:-ami-0d9154058422475a4}"                # Ubuntu 24.04 arm64 (noble)
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.small}"
DEMO_IP="${DEMO_IP:?set DEMO_IP to the demo host egress IP with /32, e.g. 203.0.113.7/32}"
SG_NAME="${SG_NAME:-dfap-demo-sg}"
LT_NAME="${LT_NAME:-dfap-demo-lt}"
VOLUME_GIB="${VOLUME_GIB:-20}"

echo "region=$AWS_REGION vpc=$VPC subnet=$SUBNET ami=$AMI type=$INSTANCE_TYPE rdp_from=$DEMO_IP"

# --- 1. Security group: RDP from the demo host only -------------------------
SG_ID="$(aws ec2 create-security-group \
  --group-name "$SG_NAME" \
  --description "DisFAP evaluation demo: RDP from the demo host only" \
  --vpc-id "$VPC" \
  --query GroupId --output text)"
echo "created security group $SG_ID"

aws ec2 authorize-security-group-ingress \
  --group-id "$SG_ID" --protocol tcp --port 3389 --cidr "$DEMO_IP"
aws ec2 create-tags --resources "$SG_ID" --tags Key=dfap:managed,Value=true

# --- 2. Launch template: the whole VM spec ----------------------------------
# The app sends the root-volume mapping and userData on RunInstances; the
# template owns AMI, type, subnet, public IPv4, IMDSv2 and the security group.
LT_JSON="$(mktemp)"
cat > "$LT_JSON" <<JSON
{
  "ImageId": "$AMI",
  "InstanceType": "$INSTANCE_TYPE",
  "MetadataOptions": { "HttpTokens": "required", "HttpEndpoint": "enabled" },
  "NetworkInterfaces": [
    {
      "DeviceIndex": 0,
      "SubnetId": "$SUBNET",
      "Groups": ["$SG_ID"],
      "AssociatePublicIpAddress": true
    }
  ],
  "BlockDeviceMappings": [
    {
      "DeviceName": "/dev/sda1",
      "Ebs": { "VolumeSize": $VOLUME_GIB, "VolumeType": "gp3", "DeleteOnTermination": true }
    }
  ]
}
JSON

LT_ID="$(aws ec2 create-launch-template \
  --launch-template-name "$LT_NAME" \
  --launch-template-data "file://$LT_JSON" \
  --query 'LaunchTemplate.LaunchTemplateId' --output text)"
rm -f "$LT_JSON"
echo "created launch template $LT_ID"

cat <<EOF

Setup complete. Add these to .env and restart the API:

  CLOUD_PROVIDER=aws
  AWS_REGION=$AWS_REGION
  AWS_LAUNCH_TEMPLATE_ID=$LT_ID
  AWS_SESSION_AMI_ID=$AMI
  AWS_SESSION_INSTANCE_TYPE=$INSTANCE_TYPE
  AWS_SESSION_ARCHITECTURE=arm64
  AWS_SESSION_VOLUME_GIB=$VOLUME_GIB

Teardown when finished: bash scripts/demo/aws-teardown.sh
EOF
