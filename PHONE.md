# OBD Dash on iPhone, no server

Everything runs on the phone: talking to the adapter, the sensor formulas, and the database
with your dashboards, trips and GPS locations. No laptop, no Mac, no Apple developer account.

## Why Bluetooth and Bluefy

A web page can't open the raw network connection the Veepeak WiFi adapter needs, in any iPhone
browser. A web page *can* talk to a **Bluetooth LE** adapter, but Safari doesn't support that, so the
app is opened in **Bluefy**, a free App Store browser that adds Web Bluetooth.

## What you need

1. A **Bluetooth LE** (BLE / "Bluetooth 4.0", iOS-compatible) ELM327 adapter. Adapters sold as
   working with iPhone are BLE. Classic-Bluetooth (Android-only) adapters won't show up.
   The app recognises the common BLE OBD2 layouts (FFF0, FFE0, 18F0 services and OBDLink-style).
2. **Bluefy – Web BLE Browser** from the App Store (free).
3. The `phone-app/` folder hosted on any **HTTPS** address (Bluetooth and location need HTTPS).
   GitHub Pages works and is free; any static host does.

## First time

1. Plug the adapter in and turn the ignition on.
2. Open the app's address in Bluefy. It starts in **simulator** mode so you can try it.
3. ☰ → Data source → **OBD2 adapter (Bluetooth)** → *Reconnect*, and pick your adapter in the list.
4. Bluefy's share button → *Add to Home Screen* if you want an icon.

Each drive: open the app and tap the red status pill at the top to pick the adapter
(browsers need a tap before they may connect to Bluetooth).

## Recording and the map

- Tap **● REC**. Each polling cycle saves every sensor on the current dashboard, and the phone's GPS
  position is saved about once a second (allow location when asked). The button shows "REC · GPS".
- ☰ → Recorded trips → **Map** shows the route coloured by a sensor; tap any dot to see what every
  sensor read at that spot. **CSV** exports the trip (time, latitude, longitude, every sensor) to
  Files, Mail, Numbers, etc.
- Keep the app open with the screen on while recording. iOS pauses web pages in the background.

## Where the data lives

In Bluefy's storage for the app's address, on the phone. It isn't uploaded anywhere. Deleting
Bluefy or clearing its website data deletes it, so export CSVs of trips you want to keep.
The map's street tiles load from OpenStreetMap, so the background map needs mobile data.

## Notes and guesses

- Not yet tested on a real phone or adapter; tested with a simulated adapter (also through a
  simulated Bluetooth connection).
- Bluetooth adapters are usually slower than WiFi ones; expect roughly 5–15 readings a second,
  shared between the sensors on the current dashboard.
