# ============================================================================
# install-software.ps1
# Installs target software packages on the Windows VM image.
# Receives a comma-separated list of software identifiers via the
# SOFTWARE_PACKAGES environment variable.
#
# Called by: Packer provisioner in base-windows.pkr.hcl (Step 2)
#
# Supported Software IDs:
#   - chocolatey-base     : Installs Chocolatey package manager
#   - adobe-reader        : Adobe Acrobat Reader
#   - vscode              : Visual Studio Code
#   - firefox             : Mozilla Firefox
#   - chrome              : Google Chrome
#   - 7zip                : 7-Zip archiver
#   - notepadplusplus     : Notepad++
#   - vlc                 : VLC Media Player
#
# Note: Enterprise software (Adobe Creative Cloud, AutoCAD, etc.) requires
# custom installers and license keys that must be provided separately.
# ============================================================================

param(
    [string]$SoftwarePackages = $env:SOFTWARE_PACKAGES
)

Write-Host ">>> Installing software packages..."

# ---------------------------------------------------------------------------
# 1. Install Chocolatey Package Manager
# ---------------------------------------------------------------------------

Write-Host "  Installing Chocolatey package manager..."

Set-ExecutionPolicy Bypass -Scope Process -Force
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

# Install Chocolatey
Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))

# Verify installation
$chocoPath = "$env:ProgramData\chocolatey\bin\choco.exe"
if (Test-Path $chocoPath) {
    Write-Host "  ✓ Chocolatey installed successfully"
} else {
    Write-Error "  ✗ Chocolatey installation failed"
    exit 1
}

# Suppress Chocolatey prompts
choco feature enable -n=allowGlobalConfirmation

# ---------------------------------------------------------------------------
# 2. Install Common Dependencies
# ---------------------------------------------------------------------------

Write-Host "  Installing common dependencies..."

$commonPackages = @(
    "dotnetfx",          # .NET Framework (required by many apps)
    "vcredist-all",      # Visual C++ Redistributables
    "directx"            # DirectX runtime (for graphics apps)
)

foreach ($pkg in $commonPackages) {
    Write-Host "    Installing: $pkg"
    choco install $pkg -y --no-progress 2>&1 | Out-Null
}

Write-Host "  ✓ Common dependencies installed"

# ---------------------------------------------------------------------------
# 3. Install Requested Software Packages
# ---------------------------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($SoftwarePackages)) {
    Write-Host "  ⚠ No software packages specified — installing defaults"
    $SoftwarePackages = "firefox,7zip,notepadplusplus"
}

# Parse the comma-separated list
$packages = $SoftwarePackages -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }

# Map software IDs to Chocolatey packages and custom installers
$packageMap = @{
    "adobe-reader"     = @{ Type = "choco"; Package = "adobereader" }
    "vscode"           = @{ Type = "choco"; Package = "vscode" }
    "firefox"          = @{ Type = "choco"; Package = "firefox" }
    "chrome"           = @{ Type = "choco"; Package = "googlechrome" }
    "7zip"             = @{ Type = "choco"; Package = "7zip" }
    "notepadplusplus"  = @{ Type = "choco"; Package = "notepadplusplus" }
    "vlc"              = @{ Type = "choco"; Package = "vlc" }
    "gimp"             = @{ Type = "choco"; Package = "gimp" }
    "inkscape"         = @{ Type = "choco"; Package = "inkscape" }
    "blender"          = @{ Type = "choco"; Package = "blender" }
    "libreoffice"      = @{ Type = "choco"; Package = "libreoffice-fresh" }
    "putty"            = @{ Type = "choco"; Package = "putty" }
}

foreach ($pkg in $packages) {
    $pkgLower = $pkg.ToLower()
    
    if ($packageMap.ContainsKey($pkgLower)) {
        $info = $packageMap[$pkgLower]
        
        if ($info.Type -eq "choco") {
            Write-Host "    Installing via Chocolatey: $($info.Package)"
            choco install $info.Package -y --no-progress
            
            if ($LASTEXITCODE -eq 0) {
                Write-Host "    ✓ $pkg installed"
            } else {
                Write-Warning "    ⚠ $pkg installation may have had issues (exit code: $LASTEXITCODE)"
            }
        }
    } else {
        Write-Warning "    ⚠ Unknown software package: $pkg (skipping)"
        Write-Host "      Known packages: $($packageMap.Keys -join ', ')"
    }
}

# ---------------------------------------------------------------------------
# 4. Configure Desktop Shortcuts
# ---------------------------------------------------------------------------

Write-Host "  Creating desktop shortcuts for session user..."

$desktopPath = "C:\Users\Public\Desktop"

# Create a welcome text file on the desktop
$welcomeContent = @"
===================================================
  Software Sharing Session
===================================================

Welcome! This VM has been provisioned for your
software sharing session.

IMPORTANT:
- Do NOT attempt to install additional software
- Your session has a time limit
- Save your work before the session expires
- All data is temporary and will be destroyed

If you need help, contact the platform administrator.
===================================================
"@

Set-Content -Path "$desktopPath\Welcome - Read Me.txt" -Value $welcomeContent
Write-Host "  ✓ Desktop shortcuts created"

# ---------------------------------------------------------------------------
# 5. Summary
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "✅ Software installation complete"
Write-Host "   Installed packages: $($packages -join ', ')"
