# ---------------------------------------------------------------------------
# session-fleet :: network.tf
#
# The VPC and its routing. The defining design choice here is the ABSENCE of a
# NAT Gateway: private session subnets have no default route to the internet.
# Everything AWS-facing that a private instance needs (SSM, KMS, ECR, Logs, S3)
# is reached through VPC endpoints below — cheaper than a NAT Gateway (~$32/mo +
# per-GB) and a smaller blast radius (no arbitrary outbound from tenant VMs).
#
# An optional t4g.nano NAT *instance* (var.enable_nat_instance, default OFF) is
# the only escape hatch, and even then it is a single cheap instance, not a
# managed gateway.
# ---------------------------------------------------------------------------

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true # required for interface endpoints' private DNS
  enable_dns_hostnames = true # ditto

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-vpc"
  })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-igw"
  })
}

# --- Public subnets ---------------------------------------------------------
# Host the control plane (control host / optional NAT instance / endpoint ENIs
# do NOT live here — they live in private subnets). Public subnets carry only
# the internet-facing control host and NAT instance.

resource "aws_subnet" "public" {
  count             = var.az_count
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.public_subnet_cidrs[count.index]
  availability_zone = local.azs[count.index]

  # Control host gets its public IP explicitly via its ENI, not by subnet
  # default. Session VMs never land here.
  map_public_ip_on_launch = false

  tags = merge(local.common_tags, {
    Name          = "${var.name_prefix}-public-${local.azs[count.index]}"
    "dfap:subnet" = "public"
  })
}

# --- Private subnets --------------------------------------------------------
# Where session workspace VMs and the VPC interface endpoints live. No route to
# the IGW.

resource "aws_subnet" "private" {
  count             = var.az_count
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.private_subnet_cidrs[count.index]
  availability_zone = local.azs[count.index]

  map_public_ip_on_launch = false

  tags = merge(local.common_tags, {
    Name          = "${var.name_prefix}-private-${local.azs[count.index]}"
    "dfap:subnet" = "private"
  })
}

# --- Public routing ---------------------------------------------------------

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-rt-public"
  })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count          = var.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# --- Private routing --------------------------------------------------------
# One route table per AZ. In the default (no-NAT) posture these tables contain
# only the implicit local route + the S3 gateway-endpoint prefix-list route.
# When a NAT instance is enabled, a per-table default route to it is added.

resource "aws_route_table" "private" {
  count  = var.az_count
  vpc_id = aws_vpc.this.id

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-rt-private-${local.azs[count.index]}"
  })
}

resource "aws_route_table_association" "private" {
  count          = var.az_count
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# ---------------------------------------------------------------------------
# Optional NAT *instance* (NOT a NAT Gateway). Default OFF.
# A single t4g.nano in the first public subnet, source/dest check disabled so it
# can forward. Private route tables get a default route to its primary ENI.
# ---------------------------------------------------------------------------

resource "aws_security_group" "nat_instance" {
  count       = var.enable_nat_instance ? 1 : 0
  name        = "${var.name_prefix}-nat-instance"
  description = "Optional NAT instance: forward private-subnet egress."
  vpc_id      = aws_vpc.this.id

  # Accept traffic from the private subnets it is NATing for.
  ingress {
    description = "Forwarded traffic from private subnets"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = local.private_subnet_cidrs
  }

  # It must reach the internet to actually perform the NAT.
  egress {
    description = "NAT egress to internet"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-nat-instance"
  })
}

resource "aws_instance" "nat" {
  count                  = var.enable_nat_instance ? 1 : 0
  ami                    = var.nat_instance_ami_id
  instance_type          = var.nat_instance_type
  subnet_id              = aws_subnet.public[0].id
  vpc_security_group_ids = [aws_security_group.nat_instance[0].id]

  # A NAT instance MUST have source/destination checking disabled or the VPC
  # router drops packets it forwards on behalf of other hosts.
  source_dest_check           = false
  associate_public_ip_address = true

  metadata_options {
    http_tokens   = "required" # IMDSv2 only
    http_endpoint = "enabled"
  }

  root_block_device {
    encrypted             = true
    delete_on_termination = true
  }

  tags = merge(local.common_tags, {
    Name         = "${var.name_prefix}-nat"
    "dfap:role"  = "nat-instance"
  })
}

# Default route for private subnets THROUGH the NAT instance, only when enabled.
resource "aws_route" "private_nat" {
  count                  = var.enable_nat_instance ? var.az_count : 0
  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  network_interface_id   = aws_instance.nat[0].primary_network_interface_id
}

# ---------------------------------------------------------------------------
# VPC Endpoints — the NAT-free path to AWS. This is what makes the no-NAT
# posture actually usable.
# ---------------------------------------------------------------------------

# Endpoint ENIs get their own SG: allow 443 from within the VPC only.
resource "aws_security_group" "endpoints" {
  name        = "${var.name_prefix}-vpce"
  description = "HTTPS from within the VPC to interface endpoints."
  vpc_id      = aws_vpc.this.id

  ingress {
    description = "HTTPS from VPC CIDR"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  # Endpoint ENIs never initiate outbound connections; no egress rules =
  # default-deny egress.
  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-vpce"
  })
}

# Interface endpoints (one ENI per AZ), private DNS on so SDK calls to the
# public service name resolve to the endpoint automatically.
resource "aws_vpc_endpoint" "interface" {
  for_each = local.interface_endpoint_services

  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${local.region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-vpce-${each.value}"
  })
}

# S3 GATEWAY endpoint (free, prefix-list route) — used for ECR layer blobs and
# the recordings bucket without touching the internet. Attached to every private
# route table.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${local.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.private[*].id

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-vpce-s3"
  })
}
