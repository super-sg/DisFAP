# ============================================================================
# Terraform Module: Networking
# Creates the VPC, subnets, NAT Gateway, and Security Groups for session VMs.
# VMs are placed in private subnets — only Guacamole can reach them.
# ============================================================================

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# ---------------------------------------------------------------------------
# VPC
# ---------------------------------------------------------------------------

resource "aws_vpc" "session_vpc" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-vpc"
  })
}

# ---------------------------------------------------------------------------
# Subnets
# ---------------------------------------------------------------------------

# Public subnet — for NAT Gateway and Guacamole server
resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.session_vpc.id
  cidr_block              = var.public_subnet_cidr
  availability_zone       = var.availability_zone
  map_public_ip_on_launch = true

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-public"
    Tier = "public"
  })
}

# Private subnet — for session VMs (NO public IPs)
resource "aws_subnet" "private" {
  vpc_id                  = aws_vpc.session_vpc.id
  cidr_block              = var.private_subnet_cidr
  availability_zone       = var.availability_zone
  map_public_ip_on_launch = false

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-private"
    Tier = "private"
  })
}

# ---------------------------------------------------------------------------
# Internet Gateway (for public subnet)
# ---------------------------------------------------------------------------

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.session_vpc.id

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-igw"
  })
}

# ---------------------------------------------------------------------------
# NAT Gateway (allows private VMs to reach internet for license activation)
# ---------------------------------------------------------------------------

resource "aws_eip" "nat" {
  domain = "vpc"

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-nat-eip"
  })
}

resource "aws_nat_gateway" "nat" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public.id

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-nat"
  })

  depends_on = [aws_internet_gateway.igw]
}

# ---------------------------------------------------------------------------
# Route Tables
# ---------------------------------------------------------------------------

# Public route table — routes to Internet Gateway
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.session_vpc.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-public-rt"
  })
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# Private route table — routes to NAT Gateway
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.session_vpc.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.nat.id
  }

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-private-rt"
  })
}

resource "aws_route_table_association" "private" {
  subnet_id      = aws_subnet.private.id
  route_table_id = aws_route_table.private.id
}

# ---------------------------------------------------------------------------
# Security Groups
# ---------------------------------------------------------------------------

# SG for session VMs — only allow RDP/VNC from Guacamole
resource "aws_security_group" "session_vm" {
  name_prefix = "${var.project_name}-session-vm-"
  description = "Security group for ephemeral session VMs. Only allows RDP/VNC from Guacamole."
  vpc_id      = aws_vpc.session_vpc.id

  # RDP from Guacamole server only
  ingress {
    description     = "RDP from Guacamole"
    from_port       = 3389
    to_port         = 3389
    protocol        = "tcp"
    security_groups = [aws_security_group.guacamole.id]
  }

  # VNC from Guacamole server only
  ingress {
    description     = "VNC from Guacamole"
    from_port       = 5901
    to_port         = 5901
    protocol        = "tcp"
    security_groups = [aws_security_group.guacamole.id]
  }

  # Allow all outbound (needed for software license activation)
  egress {
    description = "All outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-session-vm-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

# SG for Guacamole server
resource "aws_security_group" "guacamole" {
  name_prefix = "${var.project_name}-guacamole-"
  description = "Security group for the Apache Guacamole server."
  vpc_id      = aws_vpc.session_vpc.id

  # HTTPS from anywhere (user browser access)
  ingress {
    description = "HTTPS from users"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTP redirect
  ingress {
    description = "HTTP redirect"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Guacamole API from Orchestrator
  ingress {
    description = "Guacamole API from Orchestrator"
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = var.orchestrator_cidr_blocks
  }

  # All outbound
  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-guacamole-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

# ---------------------------------------------------------------------------
# VPC Flow Logs (Audit Trail)
# ---------------------------------------------------------------------------

resource "aws_flow_log" "vpc_flow_log" {
  count = var.enable_flow_logs ? 1 : 0

  iam_role_arn    = var.flow_log_role_arn
  log_destination = var.flow_log_group_arn
  traffic_type    = "ALL"
  vpc_id          = aws_vpc.session_vpc.id

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-flow-logs"
  })
}
