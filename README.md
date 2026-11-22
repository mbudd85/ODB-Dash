# OBD Dash

A web app for OBD2 adapters (ELM327-compatible: Veepeak Mini WiFi, Bluetooth LE adapters…).
Build your own dashboards by picking which sensors to show, as gauges, big numbers or live graphs,
record trips with GPS, and see them on a map.

There are two ways to run it:

| | **Phone version** (`phone-app/`) | **Server version** (`server.py`) |
|---|---|---|
| Runs on | the phone only, inside the browser | a laptop / Raspberry Pi, phone opens it |
| Data stored | on the phone (browser storage) | `obd.db` next to `server.py` |
| Adapter | Bluetooth LE OBD2 adapter (Web Bluetooth) | Veepeak WiFi (TCP 192.168.0.10:35000) |
| iPhone browser | **Bluefy** (Safari has no Bluetooth or raw sockets) | Safari |

**Raspberry Pi in the car:** the server version, started at boot, auto-recording trips, with the dashboard
full screen on the Pi's display. See **[PI.md](PI.md)**.

See **[PHONE.md](PHONE.md)** for the iPhone setup of the phone version.

## Server version: why there's a small Python server

Browsers can't open a raw TCP connection, and the Veepeak only speaks raw TCP
(`192.168.0.10`, port `35000`). So `server.py` connects to the adapter, polls the
sensors your current dashboard shows, and streams them to the browser over a WebSocket.
It also serves the web app and keeps a local SQLite database (`obd.db`) with your
dashboards and any trips you record. SQLite comes with Python, so there's nothing else to install.

By default the server only accepts connections from the device it runs on, so when it runs
on your phone, only your phone can see it. Use `--listen 0.0.0.0` if you ever want to open it
from another device.

```
 Car ── OBD port ── Veepeak (WiFi AP 192.168.0.10:35000) ──TCP── server.py ──WebSocket── browser / phone
```

## Run it

```bash
pip install -r requirements.txt

python server.py --sim     # try it with the built-in simulated car
python server.py           # real adapter at 192.168.0.10:35000
```

Then open <http://localhost:8080>. You can also switch between simulator and adapter,
or change the adapter IP/port, from the ☰ menu without restarting.

Options: `--obd-host`, `--obd-port`, `--port` (web port, default 8080), `--listen`,
`--auto-record` (record a trip whenever the adapter is connected), `--gps` (positions from gpsd / USB GPS).

## Server version on an iPhone (location + map)

`start-iphone.bat` (or `python server.py --iphone`) listens on WiFi and turns on HTTPS, which Safari
needs before it will share your location. One-time on the iPhone: open `http://<laptop-ip>:8080/ca.crt`,
install the profile (Settings → General → VPN & Device Management), then turn it on under
Settings → General → About → Certificate Trust Settings. After that use `https://<laptop-ip>:8443`.

## Server version on an Android phone (Termux)

Everything (server, database, web app) lives on the phone.

1. Install **Termux** from F-Droid (the Play Store version is outdated).
2. In Termux:
   ```bash
   pkg install python
   pip install aiohttp
   termux-setup-storage              # lets Termux see your Downloads folder
   cp -r ~/storage/downloads/obd-dashboard ~/   # after unzipping obd-dashboard.zip there
   cd ~/obd-dashboard
   termux-wake-lock                  # keep running with the screen off
   python server.py
   ```
3. Open Chrome on the phone at <http://localhost:8080>, then ⋮ → *Add to Home screen*.
4. Join the Veepeak's WiFi. When Android warns it has no internet, choose *stay connected*.

Next time, just open Termux and run `cd ~/obd-dashboard && python server.py`.

## Using it in the car

1. Plug the Veepeak in and turn the ignition on.
2. Join the device that runs `server.py` to the adapter's WiFi (named like `V-LINK` / `WiFi_OBDII`).
3. Start `python server.py` and open the page.

The device running the server must be on the Veepeak's WiFi. Phones can't join two WiFi
networks at once, and while on the Veepeak's network they have no internet through WiFi.

## Using the app

- **Tabs** at the top are dashboards. `+` adds one.
- **✎** turns on edit mode: *Add sensor*, rename/delete the dashboard, and per-widget
  ◀ ▶ (reorder), ⚙ (change display, size, min/max, warning threshold) and ✕ (remove).
- Sensors the car doesn't report are listed as "not supported" (the app asks the car on connect).
- Only the sensors on the dashboard you're looking at are polled, so fewer widgets = faster updates.
- **● REC** records every reading on the current dashboard to the database as a trip.
  The ☰ menu lists trips with *CSV* download (opens in Excel/Sheets) and *Delete*.
- **Sensors** come from three places (filter chips in *Add sensor*):
  - *Standard*: every numeric SAE J1979 sensor (about 85). Works on any car; the car says which it has.
  - *Ford* / *Mazda*: manufacturer "enhanced" sensors in `obd/vehicles/*.json`. These are marked
    **unverified**: they come from community lists and vary by model/year. CAN-bus cars (≈2008+) only.
  - *Custom*: add your own in ☰ → Custom sensors (header, command, formula), with a *Test on car* button.
- ☰ → **Test console** sends one read-only request (e.g. header `7E1`, command `221E1C`) and shows the raw reply.
  Commands that clear codes or write to the car are blocked everywhere.
- ☰ menu: data source, metric/imperial units, and **Read check-engine codes** (read only, it never clears codes).
- On a phone, use "Add to Home Screen" for a full-screen app.

## Files

- `server.py` – web server + adapter bridge
- `obd/db.py` – SQLite database (dashboards, trips, readings)
- `obd/elm327.py` – ELM327 protocol (init, PID requests, reply parsing, trouble codes)
- `obd/pids.py` – standard sensor list + registry; `obd/formula.py` – safe formula evaluator
- `obd/vehicles/ford.json`, `mazda.json` – manufacturer sensors (add more files for other makes)
- `obd/simulator.py` – fake adapter that drives a 60-second loop
- `static/` – the web app (plain HTML/CSS/JS, no build step), shared by both versions
- `static/phone/` – the phone version's engine: ELM327 protocol, simulator, Bluetooth, on-phone database
- `tools/build_phone.py` – builds `phone-app/` (run after changing anything in `static/`)
- `obd/certs.py` – local HTTPS certificates for `--iphone`
- `tests/` – `python -m unittest discover tests`
