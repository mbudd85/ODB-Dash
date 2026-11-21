// Trips map: where each recorded reading was taken.
"use strict";

const $ = (s) => document.querySelector(s);
const units = localStorage.getItem("units") || "metric";
const CONV = {
  "km/h": ["mph", (v) => v * 0.621371], "°C": ["°F", (v) => v * 9 / 5 + 32],
  "km": ["mi", (v) => v * 0.621371], "kPa": ["psi", (v) => v * 0.145038], "L/h": ["gal/h", (v) => v * 0.264172],
};
const unitOf = (p) => (units === "imperial" && CONV[p.unit] ? CONV[p.unit][0] : p.unit);
const conv = (p, v) => (units === "imperial" && CONV[p.unit] ? CONV[p.unit][1](v) : v);
const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

// Blue -> green -> yellow -> red
const STOPS = [[0, [63, 182, 255]], [0.4, [63, 185, 80]], [0.7, [240, 180, 41]], [1, [248, 81, 73]]];
function colour(f) {
  f = Math.max(0, Math.min(1, f));
  for (let i = 1; i < STOPS.length; i++) {
    const [f1, c1] = STOPS[i], [f0, c0] = STOPS[i - 1];
    if (f <= f1) {
      const k = (f - f0) / (f1 - f0);
      return `rgb(${c0.map((c, j) => Math.round(c + (c1[j] - c) * k)).join(",")})`;
    }
  }
}
$("#bar").style.background = `linear-gradient(90deg, ${STOPS.map(([f]) => colour(f)).join(",")})`;

const map = L.map("map", { zoomControl: true }).setView([39.5, -98.35], 4);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const layer = L.layerGroup().addTo(map);

let pids = {}, track = null;

function message(text) {
  document.querySelector(".msg")?.remove();
  if (!text) return;
  const d = document.createElement("div");
  d.className = "msg"; d.textContent = text;
  document.body.append(d);
}

async function init() {
  for (const p of await (await fetch("api/pids")).json()) pids[p.code] = p;
  const { trips } = await (await fetch("api/trips")).json();
  const sel = $("#tripSel");
  if (!trips.length) { message("No trips recorded yet. Tap ● REC on the dashboard while driving."); return; }
  for (const t of trips) {
    const o = document.createElement("option");
    o.value = t.id;
    o.textContent = `${t.name} (${t.n_gps ? t.n_gps + " locations" : "no locations"})`;
    sel.append(o);
  }
  const want = new URLSearchParams(location.search).get("trip");
  if (want && trips.some((t) => String(t.id) === want)) sel.value = want;
  sel.onchange = () => { history.replaceState(null, "", `?trip=${sel.value}`); loadTrip(sel.value); };
  $("#colorSel").onchange = draw;
  loadTrip(sel.value);
}

async function loadTrip(id) {
  track = await (await fetch(`api/trips/${id}/track`)).json();
  const codes = new Set();
  for (const p of track.points) Object.keys(p.values).forEach((c) => codes.add(c));
  const cs = $("#colorSel"), prev = cs.value;
  cs.innerHTML = "";
  const opts = [["", "Colour: none"], ["__gps_speed", "Colour: GPS speed"],
    ...[...codes].filter((c) => pids[c]).map((c) => [c, `Colour: ${pids[c].name}`])];
  for (const [v, label] of opts) {
    const o = document.createElement("option"); o.value = v; o.textContent = label; cs.append(o);
  }
  cs.value = prev && opts.some(([v]) => v === prev) ? prev
    : codes.has("0D") ? "0D" : codes.has("0C") ? "0C" : "__gps_speed";
  draw(true);
}

function valueOf(pt, code) {
  if (code === "__gps_speed") return pt.speed == null ? null : conv({ unit: "km/h" }, pt.speed * 3.6);
  const v = pt.values[code];
  return v == null ? null : conv(pids[code], v);
}

function popup(pt) {
  const rows = Object.entries(pt.values).filter(([c]) => pids[c])
    .map(([c, v]) => `<tr><td>${pids[c].name}</td><td>${fmt(conv(pids[c], v))} ${unitOf(pids[c])}</td></tr>`).join("");
  const when = new Date(pt.t * 1000).toLocaleTimeString();
  const acc = pt.acc != null ? ` · ±${Math.round(pt.acc)} m` : "";
  return `<b>${when}${acc}</b><table>${rows || "<tr><td>No sensor readings at this point</td></tr>"}</table>
    <div style="color:var(--muted);margin-top:4px">${pt.lat.toFixed(5)}, ${pt.lon.toFixed(5)}</div>`;
}

function draw(fit = false) {
  layer.clearLayers();
  message("");
  const pts = track.points;
  const code = $("#colorSel").value;
  if (!pts.length) {
    message("This trip has no locations. Location is saved when the dashboard is opened on the https:// address with location allowed.");
    $("#lo").textContent = $("#hi").textContent = $("#sum").textContent = "";
    return;
  }
  const vals = code ? pts.map((p) => valueOf(p, code)).filter((v) => v != null) : [];
  const lo = vals.length ? Math.min(...vals) : 0, hi = vals.length ? Math.max(...vals) : 1;
  const unit = code === "__gps_speed" ? unitOf({ unit: "km/h" }) : code ? unitOf(pids[code]) : "";
  $("#lo").textContent = vals.length ? `${fmt(lo)} ${unit}` : "";
  $("#hi").textContent = vals.length ? `${fmt(hi)} ${unit}` : "";
  $("#bar").style.visibility = vals.length ? "visible" : "hidden";
  const secs = pts[pts.length - 1].t - pts[0].t;
  $("#sum").textContent = `${pts.length} locations · ` + (secs < 60 ? `${Math.round(secs)} s` : `${Math.round(secs / 60)} min`);

  const col = (p) => {
    const v = code ? valueOf(p, code) : null;
    return v == null ? "#8b949e" : colour((v - lo) / (hi - lo || 1));
  };
  for (let i = 1; i < pts.length; i++) {
    L.polyline([[pts[i - 1].lat, pts[i - 1].lon], [pts[i].lat, pts[i].lon]],
      { color: col(pts[i]), weight: 5, opacity: 0.9 }).addTo(layer);
  }
  // Tap targets: every point for short trips, thinned for long ones.
  const step = Math.max(1, Math.ceil(pts.length / 400));
  pts.forEach((p, i) => {
    if (i % step && i !== pts.length - 1) return;
    L.circleMarker([p.lat, p.lon], { radius: 5, color: "#0d1117", weight: 1, fillColor: col(p), fillOpacity: 1 })
      .bindPopup(() => popup(p)).addTo(layer);
  });
  const end = (p, label) => L.circleMarker([p.lat, p.lon], { radius: 8, color: "#fff", weight: 2, fillColor: "#0d1117", fillOpacity: 1 })
    .bindTooltip(label).bindPopup(() => popup(p)).addTo(layer);
  end(pts[0], "Start"); end(pts[pts.length - 1], "End");
  if (fit) map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lon])), { padding: [30, 30] });
}

init();
