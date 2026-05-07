# ============================================================================
# Packer — Windows Server 2022 Base Image
#
# Builds a pre-configured Windows AMI with:
#   - RDP enabled and configured for Guacamole compatibility
#   - Target software pre-installed
#   - OS hardened for security
#   - CloudWatch agent for monitoring
#   - Limited-privilege session user account
#
# Usage:
#   packer init .
#   packer build -var-file=variables.pkr.hcl base-windows.pkr.hcl
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
# Data Sources — Locate the latest Windows Server 2022 base AMI
# ---------------------------------------------------------------------------

data "amazon-ami" "windows_base" {
  filters = {
    name                = "Windows_Server-2022-English-Full-Base-*"
    root-device-type    = "ebs"
    virtualization-type = "hvm"
  }
  most_recent = true
  owners      = ["amazon"]
  region      = var.aws_region
}

# ---------------------------------------------------------------------------
# Locals — Computed values
# ---------------------------------------------------------------------------

locals {
  ami_name    = "${var.project_name}-windows-${var.image_version}-${formatdate("YYYYMMDD-hhmmss", timestamp())}"
  build_time  = timestamp()

  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "packer"
    ImageType   = "session-vm-windows"
    Version     = var.image_version
    BuildTime   = local.build_time
  }
}

# ---------------------------------------------------------------------------
# Source — Amazon EBS-backed builder
# ---------------------------------------------------------------------------

source "amazon-ebs" "windows" {
  # AWS Settings
  region        = var.aws_region
  profile       = var.aws_profile != "" ? var.aws_profile : null
  instance_type = var.builder_instance_type

  # Source AMI
  source_ami = data.amazon-ami.windows_base.id

  # AMI Output
  ami_name        = local.ami_name
  ami_description = "Pre-configured Windows Server 2022 for software sharing sessions. Version: ${var.image_version}"
  ami_regions     = [var.aws_region]

  # EBS Configuration — encrypted, delete on termination
  launch_block_device_mappings {
    device_name           = "/dev/sda1"
    volume_size           = var.builder_volume_size
    volume_type           = "gp3"
    delete_on_termination = true
    encrypted             = true
  }

  # Communication — WinRM for Windows provisioning
  communicator   = "winrm"
  winrm_username = "Administrator"
  winrm_timeout  = "15m"
  winrm_use_ssl  = true
  winrm_insecure = true

  # User data to enable WinRM on the builder instance
  user_data = <<-EOF
    <powershell>
    # Enable WinRM for Packer communication
    Set-ExecutionPolicy Unrestricted -Force
    
    # Configure WinRM
    winrm quickconfig -q
    winrm set winrm/config/winrs '@{MaxMemoryPerShellMB="1024"}'
    winrm set winrm/config '@{MaxTimeoutms="1800000"}'
    winrm set winrm/config/service '@{AllowUnencrypted="true"}'
    winrm set winrm/config/service/auth '@{Basic="true"}'
    
    # Configure WinRM HTTPS listener
    $cert = New-SelfSignedCertificate -DnsName "packer-build" -CertStoreLocation "Cert:\LocalMachine\My"
    winrm create winrm/config/Listener?Address=*+Transport=HTTPS "@{Hostname=`"packer-build`";CertificateThumbprint=`"$($cert.Thumbprint)`"}"
    
    # Open firewall for WinRM
    netsh advfirewall firewall add rule name="WinRM HTTPS" dir=in action=allow protocol=TCP localport=5986
    </powershell>
  EOF

  # Networking
  vpc_id    = var.vpc_id != "" ? var.vpc_id : null
  subnet_id = var.subnet_id != "" ? var.subnet_id : null

  # Tags
  tags     = local.common_tags
  run_tags = merge(local.common_tags, { Name = "packer-builder-${local.ami_name}" })
}

# ---------------------------------------------------------------------------
# Build — Provisioning Steps
# ---------------------------------------------------------------------------

build {
  name    = "windows-session-vm"
  sources = ["source.amazon-ebs.windows"]

  # ── Step 1: Enable & Configure RDP ──────────────────────────────────────
  provisioner "powershell" {
    script = "${path.root}/scripts/install-rdp.ps1"
  }

  # ── Step 2: Install Target Software ─────────────────────────────────────
  provisioner "powershell" {
    script = "${path.root}/scripts/install-software.ps1"
    environment_vars = [
      "SOFTWARE_PACKAGES=${join(",", var.software_packages)}"
    ]
  }

  # ── Step 3: Harden the OS ───────────────────────────────────────────────
  provisioner "powershell" {
    script = "${path.root}/scripts/harden-os.ps1"
    environment_vars = [
      "SESSION_USERNAME=${var.session_username}"
    ]
  }

  # ── Step 4: Install CloudWatch Agent ────────────────────────────────────
  provisioner "powershell" {
    inline = [
      "# Download and install CloudWatch Agent",
      "$installerUrl = 'https://s3.amazonaws.com/amazoncloudwatch-agent/windows/amd64/latest/amazon-cloudwatch-agent.msi'",
      "$installerPath = 'C:\\Temp\\amazon-cloudwatch-agent.msi'",
      "New-Item -ItemType Directory -Path C:\\Temp -Force | Out-Null",
      "Invoke-WebRequest -Uri $installerUrl -OutFile $installerPath -UseBasicParsing",
      "Start-Process msiexec.exe -ArgumentList '/i', $installerPath, '/qn', '/norestart' -Wait",
      "Remove-Item -Path $installerPath -Force",
      "Write-Host '✅ CloudWatch Agent installed successfully'"
    ]
  }

  # ── Step 5: Create Session User ─────────────────────────────────────────
  provisioner "powershell" {
    inline = [
      "# Create a limited-privilege session user account",
      "# The actual password will be set dynamically at VM launch via user data",
      "$username = '${var.session_username}'",
      "$tempPassword = ConvertTo-SecureString 'TemporaryP@ss123!' -AsPlainText -Force",
      "",
      "New-LocalUser -Name $username -Password $tempPassword -FullName 'Session User' -Description 'Limited account for software sharing sessions' -AccountNeverExpires",
      "Add-LocalGroupMember -Group 'Remote Desktop Users' -Member $username",
      "",
      "# Remove from Administrators group if accidentally added",
      "try { Remove-LocalGroupMember -Group 'Administrators' -Member $username -ErrorAction SilentlyContinue } catch {}",
      "",
      "Write-Host '✅ Session user account created: $username'"
    ]
  }

  # ── Step 6: Cleanup & Sysprep Preparation ───────────────────────────────
  provisioner "powershell" {
    inline = [
      "# Clean up temporary files",
      "Remove-Item -Path C:\\Temp -Recurse -Force -ErrorAction SilentlyContinue",
      "Remove-Item -Path $env:TEMP\\* -Recurse -Force -ErrorAction SilentlyContinue",
      "",
      "# Clear Windows Update cache",
      "Stop-Service -Name wuauserv -Force -ErrorAction SilentlyContinue",
      "Remove-Item -Path C:\\Windows\\SoftwareDistribution\\Download\\* -Recurse -Force -ErrorAction SilentlyContinue",
      "",
      "# Run disk cleanup",
      "cleanmgr /sagerun:1",
      "",
      "Write-Host '✅ Cleanup complete — image ready for capture'"
    ]
  }

  # ── Post-processor: Manifest ────────────────────────────────────────────
  post-processor "manifest" {
    output     = "manifest-windows.json"
    strip_path = true
  }
}
