# OBD Dash on a Raspberry Pi

The Pi sits in the car, joins the Veepeak's WiFi, reads the car, saves everything to
`obd.db` on its SD card, and shows your dashboards full screen on its own display.
No phone, no laptop.

```
 Car ── OBD port ── Veepeak (WiFi 192.168.0.10:35000) ~~WiFi~~ Raspberry Pi ── HDMI/DSI screen
                                                                   └── USB GPS (optional)
```

## What you need

- A Raspberry Pi with WiFi (Pi 3B+, 4 or 5; a Pi Zero 2 W works but is slow with the browser).
- Raspberry Pi OS **with desktop** (Bookworm or newer), on a microSD card.
- A screen. The layout is checked at 800×480 (official 7" touchscreen) and works larger.
- A car USB power supply that gives at least 3 A (5 A for a Pi 5).
- Optional: a USB GPS receiver (e.g. u-blox 7 "VK-162") to record where each reading was taken.

## Setup (once, at home with internet)

1. Flash Raspberry Pi OS with Raspberry Pi Imager. In its settings, add your **home WiFi** and a username.
2. On the Pi, open a terminal:
   ```bash
   git clone https://github.com/mbudd85/ODB-Dash.git
   cd ODB-Dash
   ./pi/install.sh "V-LINK"        # use your Veepeak's WiFi name
   sudo reboot
   ```
   The WiFi name is printed on the Veepeak's box/manual, or check what your phone sees with the adapter plugged in.
3. After the reboot the dashboard opens full screen in car mode. At home it will say
   "No adapter" until it can see the Veepeak, which is expected.

To try it at home without the car: ☰ → Data source → Simulator → Reconnect.

## In the car

- Turn the ignition on: the Pi boots, joins the Veepeak WiFi and the dashboard connects by itself.
- **Trips record automatically** while the adapter is connected and stop when the car is turned off.
  With a USB GPS, each trip also saves its route.
- ☰ → Recorded trips: **Map** and **CSV** per trip. The map's street background needs internet, so look
  at maps when the Pi is back on home WiFi (the route itself is drawn either way).
- Use ✎ on the touchscreen to build dashboards. A USB keyboard's Alt+F4 closes the full-screen browser.

## Good to know

- **Power cuts:** cutting power without shutting down can, rarely, corrupt the SD card. The database
  itself survives cut power well. For peace of mind use a "safe shutdown" power HAT, or a good-quality
  SD card and keep a backup image.
- **See trips from your laptop at home:** edit `/etc/systemd/system/obd-dash.service`, add `--listen 0.0.0.0`
  to the `ExecStart` line, then `sudo systemctl daemon-reload && sudo systemctl restart obd-dash`, and
  open `http://<pi-name>.local:8080` on the laptop.
- **Update:** `cd ~/ODB-Dash && git pull && sudo systemctl restart obd-dash`.
- **Logs:** `journalctl -u obd-dash -f`.

## Not tested yet

Tested here with the simulated adapter and a simulated GPS. Not yet run on a real Pi, Veepeak or GPS.
The Veepeak WiFi name and whether it has a password vary; the installer assumes an open network.
