#!/bin/bash
# OBD Dash on a Raspberry Pi: one-time setup.
#
#   cd ~/ODB-Dash && ./pi/install.sh "VEEPEAK_WIFI_NAME"
#
# Installs what's needed, starts the server at boot (auto-records trips, reads a
# USB GPS if plugged in), opens the dashboard full screen on the Pi's display,
# and makes the Pi join the Veepeak's WiFi whenever it's in range.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="${SUDO_USER:-$USER}"
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"
SSID="${1:-}"

echo "==> Installing packages (needs internet, takes a few minutes)"
sudo apt-get update
sudo apt-get install -y python3-aiohttp gpsd gpsd-clients curl
sudo apt-get install -y chromium || sudo apt-get install -y chromium-browser

echo "==> GPS: let gpsd pick up a USB GPS receiver automatically"
sudo tee /etc/default/gpsd >/dev/null <<'CONF'
START_DAEMON="true"
USBAUTO="true"
DEVICES=""
GPSD_OPTIONS="-n"
CONF
sudo systemctl enable --now gpsd.socket || true

echo "==> Server: start at boot"
sudo tee /etc/systemd/system/obd-dash.service >/dev/null <<UNIT
[Unit]
Description=OBD Dash (OBD2 dashboard server)
After=network.target gpsd.socket

[Service]
User=$USER_NAME
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/python3 $APP_DIR/server.py --gps --auto-record
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now obd-dash.service

echo "==> Screen: open the dashboard full screen after login"
chmod +x "$APP_DIR/pi/kiosk.sh"
KIOSK="$APP_DIR/pi/kiosk.sh"
# labwc (current Raspberry Pi OS)
mkdir -p "$USER_HOME/.config/labwc"
touch "$USER_HOME/.config/labwc/autostart"
grep -q "kiosk.sh" "$USER_HOME/.config/labwc/autostart" || echo "$KIOSK &" >> "$USER_HOME/.config/labwc/autostart"
# wayfire (2023-2024 Raspberry Pi OS)
if [ -f "$USER_HOME/.config/wayfire.ini" ] && ! grep -q "kiosk.sh" "$USER_HOME/.config/wayfire.ini"; then
  printf '\n[autostart]\nobd_dash = %s\n' "$KIOSK" >> "$USER_HOME/.config/wayfire.ini"
fi
# LXDE / X11 (older Raspberry Pi OS)
if [ -d /etc/xdg/lxsession/LXDE-pi ]; then
  mkdir -p "$USER_HOME/.config/lxsession/LXDE-pi"
  F="$USER_HOME/.config/lxsession/LXDE-pi/autostart"
  [ -f "$F" ] || cp /etc/xdg/lxsession/LXDE-pi/autostart "$F"
  grep -q "kiosk.sh" "$F" || echo "@$KIOSK" >> "$F"
fi
chown -R "$USER_NAME": "$USER_HOME/.config"
# Log in to the desktop automatically and keep the screen on.
if command -v raspi-config >/dev/null; then
  sudo raspi-config nonint do_boot_behaviour B4 || true
  sudo raspi-config nonint do_blanking 1 || true
fi

if [ -n "$SSID" ]; then
  echo "==> WiFi: join \"$SSID\" (the Veepeak) whenever it's in range"
  if ! nmcli -t -f NAME con show | grep -qx "$SSID"; then
    sudo nmcli con add type wifi ifname wlan0 con-name "$SSID" ssid "$SSID"
  fi
  # Prefer the Veepeak over home WiFi; it has no internet, so don't route the internet through it.
  sudo nmcli con modify "$SSID" connection.autoconnect yes connection.autoconnect-priority 50 \
    ipv4.method auto ipv4.never-default yes ipv6.method ignore
  echo "    (If your Veepeak WiFi has a password: sudo nmcli con modify \"$SSID\" wifi-sec.key-mgmt wpa-psk wifi-sec.psk PASSWORD)"
else
  echo "==> WiFi: skipped. Re-run with the Veepeak's WiFi name to set it up: ./pi/install.sh \"V-LINK\""
fi

echo
echo "Done. Reboot to start everything:  sudo reboot"
echo "Server logs:  journalctl -u obd-dash -f"
