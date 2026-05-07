#!/usr/bin/env bash
# ============================================================================
# install-vnc.sh
# Installs and configures TigerVNC server for Guacamole access on Ubuntu.
# Called by: Packer provisioner in base-linux.pkr.hcl (Step 3)
# ============================================================================
set -euo pipefail

echo ">>> Installing and configuring VNC server..."

# Install TigerVNC
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y tigervnc-standalone-server tigervnc-common

# Create VNC config directory for session-user
SESSION_USER="${SESSION_USERNAME:-session-user}"
sudo mkdir -p /home/$SESSION_USER/.vnc

# Create xstartup script for XFCE4
sudo tee /home/$SESSION_USER/.vnc/xstartup > /dev/null << 'XSTARTUP'
#!/bin/bash
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
exec startxfce4
XSTARTUP

sudo chmod +x /home/$SESSION_USER/.vnc/xstartup
sudo chown -R $SESSION_USER:$SESSION_USER /home/$SESSION_USER/.vnc

# Create VNC config
sudo tee /home/$SESSION_USER/.vnc/config > /dev/null << 'VNCCONFIG'
geometry=1920x1080
depth=24
localhost=no
alwaysshared
VNCCONFIG

sudo chown $SESSION_USER:$SESSION_USER /home/$SESSION_USER/.vnc/config

# Create systemd service for VNC
sudo tee /etc/systemd/system/vncserver@.service > /dev/null << 'SYSTEMD'
[Unit]
Description=VNC Server for display %i
After=network-online.target

[Service]
Type=simple
User=session-user
Group=session-user
WorkingDirectory=/home/session-user
ExecStartPre=/bin/sh -c '/usr/bin/vncserver -kill :%i > /dev/null 2>&1 || :'
ExecStart=/usr/bin/vncserver :%i -fg -geometry 1920x1080 -depth 24 -localhost no
ExecStop=/usr/bin/vncserver -kill :%i
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SYSTEMD

sudo systemctl daemon-reload
sudo systemctl enable vncserver@1.service

echo "✅ VNC server installed and configured"
echo "   - Display: :1 (port 5901)"
echo "   - Resolution: 1920x1080"
echo "   - Desktop: XFCE4"
