# OBD Dash on an Amazon Fire tablet

A real app for the tablet. It talks to the **Veepeak WiFi adapter directly**, so there's no laptop,
no server and no internet needed in the car. Dashboards, Ford/Mazda factory sensors, MPG and
horsepower estimates, trouble codes, misfire counts, recording trips and the trips map all work
inside the app, and everything is saved on the tablet.

## Install it (once)

1. On the tablet: **Settings → Security & Privacy → Apps from Unknown Sources** and turn it on for
   **Silk Browser**. (On older Fire OS it's a single "Apps from Unknown Sources" switch.)
2. Open **Silk** on the tablet (on your home WiFi) and go to the latest build:
   `https://github.com/mbudd85/odb-dash/releases/latest/download/OBD-Dash.apk`
   It downloads `OBD-Dash.apk`.
3. Open the download (Silk's download notice, or the **Files** app → Downloads) and tap **Install**.
   Fire OS may warn that the app isn't from the Appstore; that's expected for a sideloaded app.
4. "OBD Dash" is now on the home screen.

**Updating:** download and install the new APK the same way. It installs over the old one and
keeps your dashboards and trips.

No Silk access? Download `OBD-Dash.apk` on the laptop, plug the tablet in by USB, copy the file into
the tablet's **Download** folder, then open it with the Files app.

## Each drive

1. Plug the Veepeak in and turn the ignition on.
2. Tablet: **Settings → Wireless & Networks → WiFi**, join the adapter's network (usually **V-LINK**).
   If Fire OS says the network has no internet, choose to **stay connected**.
3. Open OBD Dash. It connects to `192.168.0.10:35000` by itself and the status pill turns green.
   Different address or port? ☰ → Data source → OBD2 adapter (WiFi) → change it → *Reconnect*.

The app opens on a **home screen**: a big live RPM gauge with 9 shortcuts beside it (Realtime,
Fault codes, Trips map, Record, Misfires, Lamp check, Vehicle, Adapter, Settings). The Back button or
⌂ returns to it from the dashboards. **Realtime** opens digital readouts of battery voltage, coolant
temp, transmission temp, speed, RPM, instant MPG, fuel level, oil pressure and intake air temp. Tiles a
car doesn't report show N/A (no known OBD2 oil pressure sensor exists for these vehicles yet).
Every dashboard is yours to change: ✎ adds, removes and moves tiles, the **+** tab makes a new one,
as many as you like. With only RPM and speed to read, the home gauge updates as fast
as the adapter allows; the footer on the dashboards shows updates/s and ms per request.

The screen stays on while the app is open, so it works as an in-car display (plug the tablet into
the car's USB). ☰ → Data source → *Simulator* lets you try it without a car.

## Recording, the map and CSV files

- **● REC** records every sensor on the current dashboard until you tap it again.
- ☰ → Recorded trips → **CSV** saves the trip to the tablet's **Download/OBD Dash** folder.
- **Location on a Fire tablet:** Fire tablets have **no GPS chip**. They only know where they are
  from nearby WiFi networks, which needs internet, and in the car the tablet is on the adapter's
  WiFi with no internet. So trips recorded on the tablet usually won't have a route on the map.
  If you allow location when asked and the tablet does get a position, it's saved with the readings.
- The map's street background downloads from OpenStreetMap, so it only shows when the tablet has
  internet (e.g. back home on your WiFi).

## Pick your vehicle

☰ → Vehicle: choose the Mustang, Expedition, F-150 or Mazda 6, then **Check factory sensors** with
the engine running to see which Ford/Mazda sensors your car really answers.

## Where your data lives

Inside the app on the tablet. Uninstalling the app deletes it, so save CSVs of trips you want to
keep. Nothing is uploaded anywhere.

## How it's built (for later changes)

- `fire-app/` is a [Capacitor](https://capacitorjs.com) Android project that wraps the same web app
  as the phone version (`static/`, built with `tools/build_phone.py`).
- `fire-app/android/app/src/main/java/app/obddash/fire/ObdTcpPlugin.java` gives the page the raw TCP
  connection to the adapter (a browser can't open one). `static/phone/native.js` is the page side.
- GitHub Actions (`.github/workflows/fire-app.yml`) builds `OBD-Dash.apk` on every push and
  publishes it as the **fire-app-latest** release.
- The app is signed with `fire-app/android/app/obd-dash-sideload.keystore` (kept in the repo on
  purpose so every build can update the installed app; it's not a secret).
- Not on the Amazon Appstore: a store listing needs an Amazon developer account and review. The
  APK is the same file you'd submit if you ever want that.
