# ============================================================================
# install-rdp.ps1
# Enables and configures Remote Desktop Protocol on Windows Server.
# Optimized for compatibility with Apache Guacamole's RDP gateway.
#
# Called by: Packer provisioner in base-windows.pkr.hcl (Step 1)
# ============================================================================

Write-Host ">>> Configuring Remote Desktop Protocol (RDP)..."

# ---------------------------------------------------------------------------
# 1. Enable Remote Desktop
# ---------------------------------------------------------------------------

# Enable RDP via registry
Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' `
    -Name "fDenyTSConnections" -Value 0

# Allow RDP through Windows Firewall
Enable-NetFirewallRule -DisplayGroup "Remote Desktop"

# Ensure Remote Desktop Services are set to start automatically
Set-Service -Name "TermService" -StartupType Automatic
Start-Service -Name "TermService"

Write-Host "  ✓ Remote Desktop enabled"

# ---------------------------------------------------------------------------
# 2. Configure RDP for Guacamole Compatibility
# ---------------------------------------------------------------------------

# Disable Network Level Authentication (NLA)
# NLA requires pre-authentication which Guacamole's JSON auth cannot provide
# directly. Disabling NLA allows Guacamole to handle authentication at the
# RDP session level instead.
Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' `
    -Name "UserAuthentication" -Value 0

# Set security layer to RDP Security Layer (not TLS/NLA)
# This ensures maximum compatibility with Guacamole's freerdp-based client.
Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' `
    -Name "SecurityLayer" -Value 0

# Set encryption level to Client Compatible
Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' `
    -Name "MinEncryptionLevel" -Value 1

Write-Host "  ✓ NLA disabled for Guacamole compatibility"

# ---------------------------------------------------------------------------
# 3. Optimize RDP Session Settings
# ---------------------------------------------------------------------------

# Set maximum color depth to 32-bit for best visual quality
Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' `
    -Name "ColorDepth" -Value 5

# Disable wallpaper in RDP sessions to reduce bandwidth
# (Guacamole can override this per-connection)
Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' `
    -Name "fDisableWallpaper" -Value 1

# Enable font smoothing for better text readability
Set-ItemProperty -Path 'HKLM:\Software\Policies\Microsoft\Windows NT\Terminal Services' `
    -Name "bEnableFontSmoothing" -Value 1 -Force

# Set idle session timeout to 30 minutes (1,800,000 ms)
# The VM Manager will handle the actual session lifecycle, but this
# provides a safety net for abandoned sessions.
Set-ItemProperty -Path 'HKLM:\Software\Policies\Microsoft\Windows NT\Terminal Services' `
    -Name "MaxIdleTime" -Value 1800000 -Force

# Set disconnected session timeout to 5 minutes (300,000 ms)
Set-ItemProperty -Path 'HKLM:\Software\Policies\Microsoft\Windows NT\Terminal Services' `
    -Name "MaxDisconnectionTime" -Value 300000 -Force

Write-Host "  ✓ RDP session settings optimized"

# ---------------------------------------------------------------------------
# 4. Configure Firewall Rules for RDP
# ---------------------------------------------------------------------------

# Ensure RDP firewall rule exists for port 3389
$rdpRule = Get-NetFirewallRule -DisplayName "Remote Desktop - User Mode (TCP-In)" -ErrorAction SilentlyContinue
if ($null -eq $rdpRule) {
    New-NetFirewallRule -DisplayName "RDP - Guacamole Access" `
        -Direction Inbound `
        -Protocol TCP `
        -LocalPort 3389 `
        -Action Allow `
        -Profile Any `
        -Description "Allow RDP access from Guacamole server"
    Write-Host "  ✓ Created RDP firewall rule"
} else {
    Write-Host "  ✓ RDP firewall rule already exists"
}

# Block RDP access from all sources except the Guacamole server's security group
# (The actual IP restriction is handled at the AWS Security Group level)

# ---------------------------------------------------------------------------
# 5. Disable Clipboard Sharing (Security)
# ---------------------------------------------------------------------------

# Disable clipboard redirection to prevent credential leakage
# Users should not be able to copy sensitive data out of the session
Set-ItemProperty -Path 'HKLM:\Software\Policies\Microsoft\Windows NT\Terminal Services' `
    -Name "fDisableClip" -Value 1 -Force

# Disable drive redirection
Set-ItemProperty -Path 'HKLM:\Software\Policies\Microsoft\Windows NT\Terminal Services' `
    -Name "fDisableCdm" -Value 1 -Force

# Disable printer redirection
Set-ItemProperty -Path 'HKLM:\Software\Policies\Microsoft\Windows NT\Terminal Services' `
    -Name "fDisableCpm" -Value 1 -Force

Write-Host "  ✓ Clipboard, drive, and printer redirection disabled"

# ---------------------------------------------------------------------------
# 6. Verify Configuration
# ---------------------------------------------------------------------------

$rdpEnabled = (Get-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server').fDenyTSConnections
$nlaDisabled = (Get-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp').UserAuthentication

if ($rdpEnabled -eq 0 -and $nlaDisabled -eq 0) {
    Write-Host ""
    Write-Host "✅ RDP configuration complete"
    Write-Host "   - RDP: ENABLED"
    Write-Host "   - NLA: DISABLED (Guacamole compatible)"
    Write-Host "   - Port: 3389"
    Write-Host "   - Clipboard: BLOCKED"
    Write-Host "   - Drive Mapping: BLOCKED"
} else {
    Write-Error "❌ RDP configuration verification FAILED"
    exit 1
}
