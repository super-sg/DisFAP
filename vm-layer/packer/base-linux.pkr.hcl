# ============================================================================
# Packer — Ubuntu 22.04 LTS Base Image
#
# Builds a pre-configured Linux AMI with:
#   - VNC server configured for Guacamole access
#   - Desktop environment (XFCE4 — lightweight)
#   - Target software pre-installed
#   - OS hardened (UFW, fail2ban, audit logging)
#   - CloudWatch agent for monitoring
#   - Limited-privilege session user account
#
# Usage:
#   packer init .
#   packer build -var-file=variables.pkr.hcl base-linux.pkr.hcl
# ============================================================================

packer {
  required_version = ">= 1.9.0"

  required_plugins {
    amazon = {
      version = ">= 1.2.0"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

# ---------------------------------------------------------------------------
# Data Sources — Locate the latest Ubuntu 22.04 LTS AMI
# ---------------------------------------------------------------------------

data "amazon-ami" "ubuntu_base" {
  filters = {
    name                = "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"
    root-device-type    = "ebs"
    virtualization-type = "hvm"
  }
  most_recent = true
  owners      = ["099720109477"] # Canonical
  region      = var.aws_region
}

# ---------------------------------------------------------------------------
# Locals
# ---------------------------------------------------------------------------

locals {
  ami_name_linux = "${var.project_name}-linux-${var.image_version}-${formatdate("YYYYMMDD-hhmmss", timestamp())}"

  common_tags_linux = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "packer"
    ImageType   = "session-vm-linux"
    Version     = var.image_version
    BuildTime   = timestamp()
  }
}

# ---------------------------------------------------------------------------
# Source — Amazon EBS-backed builder
# ---------------------------------------------------------------------------

source "amazon-ebs" "ubuntu" {
  # AWS Settings
  region        = var.aws_region
  profile       = var.aws_profile != "" ? var.aws_profile : null
  instance_type = var.builder_instance_type

  # Source AMI
  source_ami = data.amazon-ami.ubuntu_base.id

  # AMI Output
  ami_name        = local.ami_name_linux
  ami_description = "Pre-configured Ubuntu 22.04 with VNC for software sharing sessions. Version: ${var.image_version}"
  ami_regions     = [var.aws_region]

  # EBS Configuration
  launch_block_device_mappings {
    device_name           = "/dev/sda1"
    volume_size           = var.builder_volume_size
    volume_type           = "gp3"
    delete_on_termination = true
    encrypted             = true
  }

  # Communication — SSH
  communicator = "ssh"
  ssh_username = "ubuntu"
  ssh_timeout  = "10m"

  # Networking
  vpc_id    = var.vpc_id != "" ? var.vpc_id : null
  subnet_id = var.subnet_id != "" ? var.subnet_id : null

  # Tags
  tags     = local.common_tags_linux
  run_tags = merge(local.common_tags_linux, { Name = "packer-builder-${local.ami_name_linux}" })
}

# ---------------------------------------------------------------------------
# Build — Provisioning Steps
# ---------------------------------------------------------------------------

build {
  name    = "linux-session-vm"
  sources = ["source.amazon-ebs.ubuntu"]

  # ── Step 1: System Update ───────────────────────────────────────────────
  provisioner "shell" {
    inline = [
      "echo '>>> Updating system packages...'",
      "sudo apt-get update -y",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y",
      "echo '✅ System updated'"
    ]
  }

  # ── Step 2: Install Desktop Environment (XFCE4 — lightweight) ──────────
  provisioner "shell" {
    inline = [
      "echo '>>> Installing XFCE4 desktop environment...'",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y xfce4 xfce4-goodies dbus-x11",
      "",
      "# Set XFCE as default session",
      "echo 'xfce4-session' | sudo tee /etc/X11/default-display-manager > /dev/null",
      "echo '✅ XFCE4 installed'"
    ]
  }

  # ── Step 3: Install & Configure VNC Server ──────────────────────────────
  provisioner "shell" {
    script = "${path.root}/scripts/install-vnc.sh"
  }

  # ── Step 4: Install Target Software ─────────────────────────────────────
  provisioner "shell" {
    inline = [
      "echo '>>> Installing target software...'",
      "",
      "# Install common dependencies",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \\",
      "  curl wget unzip software-properties-common \\",
      "  libgl1-mesa-glx libglib2.0-0",
      "",
      "# Software-specific installations are handled by the install scripts",
      "# and configured via the SOFTWARE_PACKAGES variable.",
      "# For now, install common creative/development tools:",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \\",
      "  gimp inkscape blender firefox",
      "",
      "echo '✅ Software installation complete'"
    ]
    environment_vars = [
      "SOFTWARE_PACKAGES=${join(",", var.software_packages)}"
    ]
  }

  # ── Step 5: Create Session User ─────────────────────────────────────────
  provisioner "shell" {
    inline = [
      "echo '>>> Creating session user account...'",
      "SESSION_USER='${var.session_username}'",
      "",
      "# Create user with home directory",
      "sudo useradd -m -s /bin/bash -c 'Session User' $SESSION_USER",
      "",
      "# Set a temporary password (will be changed dynamically at launch)",
      "echo \"$SESSION_USER:TempP@ss123\" | sudo chpasswd",
      "",
      "# Add to necessary groups for desktop access",
      "sudo usermod -aG audio,video,plugdev $SESSION_USER",
      "",
      "# Ensure they cannot sudo",
      "sudo deluser $SESSION_USER sudo 2>/dev/null || true",
      "",
      "# Create default XFCE config for session user",
      "sudo -u $SESSION_USER mkdir -p /home/$SESSION_USER/.config",
      "",
      "echo '✅ Session user created: $SESSION_USER'"
    ]
  }

  # ── Step 6: OS Hardening ────────────────────────────────────────────────
  provisioner "shell" {
    inline = [
      "echo '>>> Hardening the OS...'",
      "",
      "# Install security tools",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ufw fail2ban auditd",
      "",
      "# Configure UFW firewall",
      "sudo ufw default deny incoming",
      "sudo ufw default allow outgoing",
      "sudo ufw allow 5901/tcp comment 'VNC for Guacamole'",
      "sudo ufw allow 22/tcp comment 'SSH for management'",
      "sudo ufw --force enable",
      "",
      "# Configure fail2ban",
      "sudo systemctl enable fail2ban",
      "sudo systemctl start fail2ban",
      "",
      "# Disable root login via SSH",
      "sudo sed -i 's/^PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config",
      "sudo sed -i 's/^#PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config",
      "",
      "# Enable audit logging",
      "sudo systemctl enable auditd",
      "",
      "# Disable unused services",
      "sudo systemctl disable cups 2>/dev/null || true",
      "sudo systemctl disable avahi-daemon 2>/dev/null || true",
      "",
      "echo '✅ OS hardening complete'"
    ]
  }

  # ── Step 7: Install CloudWatch Agent ────────────────────────────────────
  provisioner "shell" {
    inline = [
      "echo '>>> Installing CloudWatch Agent...'",
      "wget -q https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb -O /tmp/cwagent.deb",
      "sudo dpkg -i /tmp/cwagent.deb",
      "rm -f /tmp/cwagent.deb",
      "echo '✅ CloudWatch Agent installed'"
    ]
  }

  # ── Step 8: Cleanup ─────────────────────────────────────────────────────
  provisioner "shell" {
    inline = [
      "echo '>>> Cleaning up...'",
      "sudo apt-get autoremove -y",
      "sudo apt-get clean",
      "sudo rm -rf /tmp/* /var/tmp/*",
      "sudo rm -rf /var/lib/apt/lists/*",
      "sudo truncate -s 0 /var/log/*.log",
      "history -c",
      "echo '✅ Cleanup complete — image ready for capture'"
    ]
  }

  # ── Post-processor: Manifest ────────────────────────────────────────────
  post-processor "manifest" {
    output     = "manifest-linux.json"
    strip_path = true
  }
}
