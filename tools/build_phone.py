"""Build the no-server phone version into phone-app/.

phone-app/ is a folder of static files: host it on any HTTPS static host
(GitHub Pages, Netlify...), open it on the iPhone, and everything (adapter
protocol, sensors, database) runs inside the page.

    python tools/build_phone.py
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "static"
OUT = ROOT / "phone-app"

subprocess.run([sys.executable, str(ROOT / "tools" / "export_sensors.py")], check=True)

if OUT.exists():
    shutil.rmtree(OUT)
shutil.copytree(SRC, OUT)

ENGINE = ["phone/formula.js", "phone/sensors.js", "phone/elm327.js", "phone/sim.js",
          "phone/ble.js", "phone/store.js", "phone/backend.js"]
tags = "\n".join(f'  <script src="{p}"></script>' for p in ENGINE)

for page, extra in (("index.html", ""), ("map.html", "  <script>window.OBD_NO_CONNECT = true;</script>\n")):
    path = OUT / page
    html = path.read_text(encoding="utf-8")
    first_app_script = re.search(r'  <script src="(app|map)\.js"></script>', html)
    if page == "map.html":
        first_app_script = re.search(r'  <script src="vendor/leaflet/leaflet\.js"></script>', html)
    i = first_app_script.start()
    html = html[:i] + extra + tags + "\n" + html[i:]
    path.write_text(html, encoding="utf-8")

# Service worker: cache every file so the app opens in the car with no internet.
files = sorted(str(p.relative_to(OUT)).replace("\\", "/") for p in OUT.rglob("*")
               if p.is_file() and p.name != "sw.js" and "LICENSE" not in p.name)
version = abs(hash(tuple((f, (OUT / f).stat().st_size) for f in files))) % 10**8
sw = (OUT / "sw.js").read_text(encoding="utf-8")
sw = re.sub(r'const CACHE = "[^"]+";', f'const CACHE = "obd-dash-phone-{version}";', sw)
sw = re.sub(r"const SHELL = \[.*?\];", "const SHELL = " + json.dumps(["./"] + files) + ";", sw, flags=re.S)
# Offline-first for the phone build: serve from cache, refresh in the background.
sw = sw.replace("""  // Network first, cache as fallback.
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request)));""", """  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => {
    const net = fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    });
    return hit || net;
  }));""")
(OUT / "sw.js").write_text(sw, encoding="utf-8")
print(f"built {OUT} ({len(files)} files)")
