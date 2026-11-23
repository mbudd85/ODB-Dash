// OBD Dash front end. Plain JS, no build step.
"use strict";

const $ = (s) => document.querySelector(s);
const HISTORY_SECONDS = 60;

const state = {
  pids: {},             // code -> {code,name,unit,min,max,category}
  dashboards: [],
  active: null,
  units: localStorage.getItem("units") || "metric",
  editing: false,
  supported: null,      // Set of codes the car reports, null until known
  vehicle: null,        // chosen vehicle profile id
  profiles: [],
  checked: {},          // factory sensor code -> answered when last checked
  latest: {},           // code -> value (raw, metric)
  history: {},          // code -> [[t, value], ...]
  widgets: new Map(),   // widget id -> {el, update()}
  ws: null,
  status: {},
};

// ---------------------------------------------------------------- units

const CONVERSIONS = {
  "km/h": ["mph", (v) => v * 0.621371],
  "°C": ["°F", (v) => v * 9 / 5 + 32],
  "km": ["mi", (v) => v * 0.621371],
  "kPa": ["psi", (v) => v * 0.145038],
  "L/h": ["gal/h", (v) => v * 0.264172],
};
// Sensors whose native unit is imperial, converted for metric display.
const METRIC_CONVERSIONS = {
  "mpg": ["L/100km", (v) => (v > 0 ? Math.min(99.9, 235.215 / v) : 0)],
};
function unitFor(info) {
  const m = state.units === "metric" && METRIC_CONVERSIONS[info.unit];
  if (m) return { unit: m[0], f: m[1] };
  const c = state.units === "imperial" && CONVERSIONS[info.unit];
  return c ? { unit: c[0], f: c[1] } : { unit: info.unit, f: (v) => v };
}
function fmt(v, info) {
  if (v == null || Number.isNaN(v)) return "–";
  const span = Math.abs(info.max - info.min);
  const d = span <= 2 ? 2 : span <= 30 ? 1 : 0;
  return v.toFixed(d);
}

// ---------------------------------------------------------------- storage

function uid() { return Math.random().toString(36).slice(2, 10); }

function defaultDashboards() {
  const w = (code, type, size = 1, extra = {}) => ({ id: uid(), code, type, size, ...extra });
  return [
    { id: uid(), name: "Driving", widgets: [
      w("0C", "gauge", 1, { warn: 6000 }), w("0D", "gauge"), w("05", "number", 1, { warn: 105 }),
      w("RV", "number"), w("11", "graph", 2), w("04", "gauge"), w("2F", "number"),
    ]},
    { id: uid(), name: "Engine health", widgets: [
      w("05", "graph", 2), w("5C", "number"), w("0F", "number"),
      w("06", "graph"), w("07", "number"), w("10", "graph", 2), w("42", "number"),
    ]},
  ];
}

async function loadDashboards() {
  let data = null;
  try { data = await (await fetch("api/dashboards")).json(); } catch {}
  if (!data) { try { data = JSON.parse(localStorage.getItem("dashboards")); } catch {} }
  const fresh = !data || !data.dashboards?.length;
  if (fresh) data = { dashboards: defaultDashboards() };
  state.dashboards = data.dashboards;
  if (fresh) save();   // so the server knows what to auto-record before you edit anything
  state.active = localStorage.getItem("activeDash");
  if (state.active !== ALL && !state.dashboards.find((d) => d.id === state.active)) state.active = state.dashboards[0].id;
}

let saveTimer;
function save() {
  const data = { dashboards: state.dashboards };
  localStorage.setItem("dashboards", JSON.stringify(data));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fetch("api/dashboards", { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data) }).catch(() => {});
  }, 400);
}

// Standard PIDs: the car tells us which it has. Enhanced/custom: unknown until we ask.
// Factory (mode 22) sensors: what "Check factory sensors" found, else whether it fits the chosen vehicle.
const isSupported = (code) => {
  const p = state.pids[code];
  if (!p || p.make === "Standard") return !state.supported || state.supported.has(code);
  if (p.make === "Calculated" || p.make === "Custom") return true;
  if (code in state.checked) return state.checked[code];
  return !(state.vehicle && p.fits && !p.fits.includes(state.vehicle));
};

const activeDash = () => state.dashboards.find((d) => d.id === state.active);

// ---------------------------------------------------------------- connection

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => subscribe();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "status") onStatus(msg);
    else if (msg.type === "data") onData(msg);
    else if (msg.type === "gps" && state.recording) gpsLabel("GPS");
  };
  ws.onclose = () => {
    onStatus({ state: "offline", message: "Server unreachable, retrying…" });
    setTimeout(connect, 2000);
  };
}

const ALL = "__all";   // the "All sensors" tab
const allCodes = () => Object.keys(state.pids).filter(isSupported);

function subscribe() {
  if (state.ws?.readyState !== WebSocket.OPEN) return;
  const codes = state.active === ALL ? allCodes() : [...new Set(activeDash().widgets.map((w) => w.code))];
  state.ws.send(JSON.stringify({ type: "subscribe", codes }));
}

function onStatus(s) {
  state.status = s;
  const el = $("#status");
  el.className = "status " + s.state;
  $("#statusText").textContent = {
    connected: state.status.config?.mode === "sim" ? "Simulator" : "Connected",
    connecting: "Connecting", error: "No adapter", offline: "Offline", idle: "Idle",
  }[s.state] || s.state;
  el.title = s.message || "";
  $("#footer").textContent = s.message || "";
  if (s.supported) state.supported = new Set(s.supported);
  if (s.o2) { state.o2 = s.o2; nameO2Sensors(); }
  if (s.state === "connected") { renderGrid(); if (state.active === ALL) subscribe(); }
  if (s.config) { fillSourceForm(s.config); setRecording(!!s.config.recording); }
  el.classList.toggle("tappable", !!s.needsTap || s.state === "error");
  $("#adapterInfo").textContent = s.version ? `Adapter: ${s.version} · Protocol: ${s.protocol || "?"}` : "";
}

function onData(msg) {
  const t = msg.t;
  for (const [code, v] of Object.entries(msg.values)) {
    state.latest[code] = v;
    if (v == null) continue;
    const h = (state.history[code] ||= []);
    h.push([t, v]);
    while (h.length && h[0][0] < t - HISTORY_SECONDS) h.shift();
  }
  for (const w of state.widgets.values()) w.update();
  if (state.active === ALL) updateAllTable();
  if (state.status.state === "connected") {
    $("#footer").textContent = `${state.status.message} · ${msg.rate} readings/s`;
  }
}

// ---------------------------------------------------------------- rendering

let lastFrame = performance.now();
(function frame(now) {
  const dt = Math.min(200, now - lastFrame);
  lastFrame = now;
  for (const w of state.widgets.values()) w.animate?.(dt);
  requestAnimationFrame(frame);
})(lastFrame);

function renderTabs() {
  const tabs = $("#tabs");
  tabs.innerHTML = "";
  for (const d of state.dashboards) {
    const b = document.createElement("button");
    b.textContent = d.name;
    b.className = d.id === state.active ? "active" : "";
    b.onclick = () => switchDash(d.id);
    tabs.append(b);
  }
  const all = document.createElement("button");
  all.textContent = "All sensors";
  all.className = state.active === ALL ? "active" : "";
  all.onclick = () => switchDash(ALL);
  tabs.append(all);
  const add = document.createElement("button");
  add.textContent = "+";
  add.className = "add";
  add.title = "New dashboard";
  add.onclick = newDashboard;
  tabs.append(add);
}

function switchDash(id) {
  state.active = id;
  localStorage.setItem("activeDash", id);
  renderTabs();
  renderGrid();
  subscribe();
}

function renderGrid() {
  const grid = $("#grid");
  grid.innerHTML = "";
  state.widgets.clear();
  const allView = state.active === ALL;
  grid.classList.toggle("alltable", allView);
  $("#editBtn").hidden = allView;
  if (allView) { $("#editbar").hidden = true; $("#empty").hidden = true; renderAllTable(); return; }
  grid.classList.toggle("editing", state.editing);
  const dash = activeDash();
  $("#empty").hidden = dash.widgets.length > 0;
  dash.widgets.forEach((w, i) => {
    const info = state.pids[w.code];
    if (!info) return;
    const el = document.createElement("div");
    el.className = "widget" + (w.size == 2 ? " wide" : "");
    el.innerHTML = `<div class="title"></div><div class="body"></div>
      <div class="tools">
        <button data-a="left" title="Move left">◀</button>
        <button data-a="right" title="Move right">▶</button>
        <button data-a="edit" title="Edit">⚙</button>
        <button data-a="del" title="Remove">✕</button>
      </div>`;
    el.querySelector(".title").textContent = info.make !== "Standard" ? `${info.name} · ${info.make}` : info.name;
    el.querySelector(".title").title = info.note || "";
    el.querySelector(".tools").onclick = (e) => {
      const a = e.target.dataset.a;
      if (a === "del") { dash.widgets.splice(i, 1); }
      else if (a === "left" && i > 0) { [dash.widgets[i - 1], dash.widgets[i]] = [dash.widgets[i], dash.widgets[i - 1]]; }
      else if (a === "right" && i < dash.widgets.length - 1) { [dash.widgets[i + 1], dash.widgets[i]] = [dash.widgets[i], dash.widgets[i + 1]]; }
      else if (a === "edit") { openWidgetDialog(w); return; }
      else return;
      save(); renderGrid(); subscribe();
    };
    const note = document.createElement("div");
    note.className = "note";
    if (!isSupported(w.code)) {
      el.classList.add("unsupported");
      note.textContent = "Not reported by this car";
    }
    el.append(note);
    grid.append(el);
    const body = el.querySelector(".body");
    const view = { gauge: makeGauge, number: makeNumber, graph: makeGraph }[w.type](body, w, info);
    // Gauges and numbers glide to each new reading at screen rate (60 fps) instead of jumping.
    const smooth = w.type !== "graph";
    let shown = null, target = null;
    state.widgets.set(w.id, {
      el,
      animate(dt) {
        if (!smooth || target == null || shown == null || shown === target) return;
        shown += (target - shown) * (1 - Math.exp(-dt / 80));
        if (Math.abs(target - shown) <= Math.abs(target) * 1e-4 + 1e-6) shown = target;
        view(shown);
      },
      update() {
        const raw = state.latest[w.code];
        const warn = w.warn != null && w.warn !== "" && raw != null && unitFor(info).f(raw) > +w.warn;
        el.classList.toggle("warn", !!warn);
        // An enhanced sensor that gets no answer: say so instead of a silent dash.
        if (isSupported(w.code)) {
          const noReply = w.code in state.latest && raw == null;
          note.textContent = noReply ? (info.make === "Standard" ? "No data" : "No reply from the car") : "";
          el.classList.toggle("unsupported", noReply);
        }
        if (smooth && raw != null && shown != null) { target = raw; return; }
        shown = target = raw;
        view(raw);
      },
    });
    state.widgets.get(w.id).update();
  });
}

function range(w, info) {
  const u = unitFor(info);
  const min = w.min != null && w.min !== "" ? +w.min : u.f(info.min);
  const max = w.max != null && w.max !== "" ? +w.max : u.f(info.max);
  return [min, max];
}

function makeNumber(body, w, info) {
  body.innerHTML = `<div class="number"><div class="value">–</div><div class="unit"></div></div>`;
  const val = body.querySelector(".value");
  const u = unitFor(info);
  body.querySelector(".unit").textContent = u.unit;
  return (raw) => { val.textContent = raw == null ? "–" : fmt(u.f(raw), info); };
}

function makeGauge(body, w, info) {
  const u = unitFor(info);
  const [min, max] = range(w, info);
  // 270° arc, centred at (60,60), radius 46.
  const arc = "M27.47 92.53 A46 46 0 1 1 92.53 92.53";
  body.innerHTML = `<div class="gauge"><svg viewBox="0 0 120 108">
      <path class="track" d="${arc}" fill="none" stroke-width="10" stroke-linecap="round" pathLength="100"/>
      <path class="fill" d="${arc}" fill="none" stroke-width="10" stroke-linecap="round" pathLength="100"
            stroke-dasharray="100 200" stroke-dashoffset="100"/>
      <text class="value" x="60" y="66" text-anchor="middle">–</text>
      <text class="unit" x="60" y="82" text-anchor="middle"></text>
      <text class="lim" x="27" y="106" text-anchor="middle"></text>
      <text class="lim" x="93" y="106" text-anchor="middle"></text>
    </svg></div>`;
  const [fill] = body.querySelectorAll(".fill");
  const val = body.querySelector(".value");
  const lims = body.querySelectorAll(".lim");
  body.querySelector(".unit").textContent = u.unit;
  lims[0].textContent = Math.round(min);
  lims[1].textContent = Math.round(max);
  return (raw) => {
    if (raw == null) { val.textContent = "–"; fill.setAttribute("stroke-dashoffset", 100); return; }
    const v = u.f(raw);
    const pct = Math.max(0, Math.min(1, (v - min) / (max - min || 1)));
    fill.setAttribute("stroke-dashoffset", 100 - pct * 100);
    val.textContent = fmt(v, info);
  };
}

function makeGraph(body, w, info) {
  const u = unitFor(info);
  const [min, max] = range(w, info);
  body.innerHTML = `<div class="graph"><div class="head"><span class="value">–</span><span class="unit"></span></div><canvas></canvas></div>`;
  const val = body.querySelector(".value");
  body.querySelector(".unit").textContent = u.unit;
  const canvas = body.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const css = getComputedStyle(document.documentElement);
  return (raw) => {
    val.textContent = raw == null ? "–" : fmt(u.f(raw), info);
    const dpr = devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = css.getPropertyValue("--line");
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H - 0.5); ctx.lineTo(W, H - 0.5); ctx.stroke();
    const h = state.history[w.code] || [];
    if (h.length < 2) return;
    const now = h[h.length - 1][0];
    // Auto-expand the range if the data goes outside it.
    let lo = min, hi = max;
    for (const [, r] of h) { const v = u.f(r); if (v < lo) lo = v; if (v > hi) hi = v; }
    const x = (t) => W - ((now - t) / HISTORY_SECONDS) * W;
    const y = (v) => H - 4 - ((u.f(v) - lo) / (hi - lo || 1)) * (H - 8);
    ctx.beginPath();
    h.forEach(([t, v], i) => (i ? ctx.lineTo(x(t), y(v)) : ctx.moveTo(x(t), y(v))));
    ctx.strokeStyle = css.getPropertyValue("--accent");
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();
    if (w.warn != null && w.warn !== "") {
      const wy = H - 4 - ((+w.warn - lo) / (hi - lo || 1)) * (H - 8);
      ctx.setLineDash([4, 4]); ctx.strokeStyle = css.getPropertyValue("--bad"); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, wy); ctx.lineTo(W, wy); ctx.stroke(); ctx.setLineDash([]);
    }
  };
}

// ---------------------------------------------------------------- widget dialog

let editingWidget = null;
let selectedCode = null;

let makeFilter = "All";

function renderMakeChips() {
  const makes = ["All", ...new Set(Object.values(state.pids).map((p) => p.make))];
  const box = $("#makeChips");
  box.innerHTML = "";
  for (const m of makes) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = m;
    b.className = m === makeFilter ? "active" : "";
    b.onclick = () => { makeFilter = m; renderMakeChips(); renderPidList($("#pidSearch").value); };
    box.append(b);
  }
}

function renderPidList(filter = "") {
  const sel = $("#pidSelect");
  sel.innerHTML = "";
  const q = filter.toLowerCase();
  const showAll = $("#showUnsupported").checked;
  const groups = {};
  for (const p of Object.values(state.pids)) {
    if (q && !p.name.toLowerCase().includes(q) && !p.category.toLowerCase().includes(q)) continue;
    if (makeFilter !== "All" && p.make !== makeFilter) continue;
    if (!showAll && !isSupported(p.code) && p.code !== selectedCode) continue;
    const g = p.make === "Standard" ? p.category : `${p.make} · ${p.category}`;
    (groups[g] ||= []).push(p);
  }
  const order = (g) => (g.includes(" · ") ? 1 : 0);
  let count = 0;
  for (const [cat, items] of Object.entries(groups).sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]))) {
    const og = document.createElement("optgroup");
    og.label = cat;
    items.sort((a, b) => supportedRank(a) - supportedRank(b) || a.name.localeCompare(b.name));
    for (const p of items) {
      const o = document.createElement("option");
      const ok = isSupported(p.code);
      const unit = unitFor(p).unit;
      const tag = !ok ? (p.make === "Standard" || p.code in state.checked ? " (not reported by this car)" : " (not for your vehicle)")
        : state.checked[p.code] ? " ✓ answers on this car"
        : !p.verified ? (p.make === "Custom" ? " (custom)" : " (unverified)") : "";
      o.value = p.code;
      o.textContent = p.name + (unit ? ` – ${unit}` : "") + tag;
      o.title = p.note || "";
      og.append(o);
      count++;
    }
    sel.append(og);
  }
  if (!count) {
    const o = document.createElement("option");
    o.disabled = true; o.textContent = "No sensors match"; sel.append(o);
    selectedCode = null;
  } else if (selectedCode && sel.querySelector(`option[value="${selectedCode}"]`)) {
    sel.value = selectedCode;
  } else {
    selectedCode = sel.querySelector("option:not([disabled])")?.value || null;
    sel.value = selectedCode;
  }
  $("#pidCount").textContent = `${count} sensor${count === 1 ? "" : "s"}`;
  showPidNote();
}

function showPidNote() {
  const p = state.pids[selectedCode];
  $("#pidNote").textContent = p?.note || "";
}

$("#pidSelect").onchange = (e) => { selectedCode = e.target.value; showPidNote(); };
$("#showUnsupported").onchange = () => renderPidList($("#pidSearch").value);

// ---------------------------------------------------------------- "All sensors" text view

let allRows = new Map();

function renderAllTable() {
  const grid = $("#grid");
  allRows = new Map();
  const codes = allCodes().map((c) => state.pids[c]).filter(Boolean)
    .sort((a, b) => (a.make === "Standard" ? 0 : 1) - (b.make === "Standard" ? 0 : 1)
      || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  const table = document.createElement("table");
  table.className = "sensors";
  table.innerHTML = `<thead><tr><th>Sensor</th><th class="num">Value</th><th>Unit</th><th>Group</th></tr></thead>`;
  const body = document.createElement("tbody");
  for (const p of codes) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td></td><td class="num">–</td><td></td><td></td>`;
    tr.children[0].textContent = p.name;
    tr.children[2].textContent = unitFor(p).unit;
    tr.children[3].textContent = p.make === "Standard" ? p.category : `${p.make} · ${p.category}`;
    tr.title = p.note || "";
    body.append(tr);
    allRows.set(p.code, { td: tr.children[1], p });
  }
  table.append(body);
  const note = document.createElement("p");
  note.className = "muted small";
  note.textContent = state.supported
    ? `${codes.length} sensors this car reports. Every one is read in turn, so values refresh about every ${Math.max(1, Math.round(codes.length / 20))} s.`
    : "Connect to the car to see which sensors it reports.";
  grid.append(note, table);
  updateAllTable();
}

function updateAllTable() {
  for (const [code, { td, p }] of allRows) {
    const raw = state.latest[code];
    td.textContent = raw == null ? (code in state.latest ? "no reply" : "–") : fmt(unitFor(p).f(raw), p);
    td.classList.toggle("muted", raw == null);
  }
}
const supportedRank = (p) => (isSupported(p.code) ? 0 : 1);

function openWidgetDialog(widget = null) {
  editingWidget = widget;
  selectedCode = widget?.code || null;
  $("#widgetDlgTitle").textContent = widget ? "Edit sensor" : "Add sensor";
  $("#widgetOk").textContent = widget ? "Save" : "Add";
  $("#wType").value = widget?.type || "gauge";
  $("#wSize").value = widget?.size || 1;
  $("#wMin").value = widget?.min ?? "";
  $("#wMax").value = widget?.max ?? "";
  $("#wWarn").value = widget?.warn ?? "";
  $("#pidSearch").value = "";
  $("#showUnsupported").checked = false;
  renderMakeChips();
  renderPidList();
  $("#widgetDlg").showModal();
}

$("#pidSearch").oninput = (e) => renderPidList(e.target.value);
$("#widgetDlg").addEventListener("close", () => {
  if ($("#widgetDlg").returnValue !== "ok" || !selectedCode) return;
  const num = (s) => (s.value === "" ? null : +s.value);
  const data = { code: selectedCode, type: $("#wType").value, size: +$("#wSize").value,
    min: num($("#wMin")), max: num($("#wMax")), warn: num($("#wWarn")) };
  if (editingWidget) Object.assign(editingWidget, data);
  else activeDash().widgets.push({ id: uid(), ...data });
  save(); renderGrid(); subscribe();
});

// In-page replacement for confirm()/prompt()/alert(). Some browsers and embedded
// views block those pop-ups silently (confirm() then just returns false).
function ask(message, { input = null, ok = "OK", cancel = "Cancel", danger = false } = {}) {
  return new Promise((resolve) => {
    const dlg = $("#askDlg");
    $("#askMsg").textContent = message;
    const field = $("#askInput");
    field.hidden = input === null;
    field.value = input ?? "";
    $("#askOk").textContent = ok;
    $("#askOk").className = danger ? "danger primary" : "primary";
    $("#askCancel").hidden = cancel === null;
    $("#askCancel").textContent = cancel || "";
    dlg.onclose = () => {
      const yes = dlg.returnValue === "ok";
      resolve(input !== null ? (yes ? field.value.trim() || null : null) : yes);
    };
    dlg.returnValue = "";
    dlg.showModal();
    if (input !== null) { field.focus(); field.select(); }
  });
}
const tell = (message) => ask(message, { cancel: null });

// ---------------------------------------------------------------- dashboards / edit mode

function setEditing(on) {
  state.editing = on;
  $("#editbar").hidden = !on;
  $("#editBtn").classList.toggle("primary", on);
  renderGrid();
}

async function newDashboard() {
  const name = await ask("Name the new dashboard", { input: "My dashboard", ok: "Create" });
  if (!name) return;
  const d = { id: uid(), name, widgets: [] };
  state.dashboards.push(d);
  save();
  switchDash(d.id);
  setEditing(true);
  $("#menuDlg").close();
}

// Tapping the status pill (re)connects. Bluetooth needs this tap to open its device picker.
$("#status").onclick = () => {
  if (state.status.state === "connected" || state.status.state === "connecting") return;
  fetch("api/connect", { method: "POST" });
};

$("#editBtn").onclick = () => setEditing(!state.editing);
$("#doneBtn").onclick = () => setEditing(false);
$("#addWidgetBtn").onclick = () => openWidgetDialog();
// Add every sensor the car reports that isn't on this dashboard yet, as number tiles.
$("#addAllBtn").onclick = async () => {
  const dash = activeDash();
  const have = new Set(dash.widgets.map((w) => w.code));
  const add = allCodes().filter((c) => !have.has(c)).map((c) => state.pids[c]).filter(Boolean)
    .sort((a, b) => (a.make === "Standard" ? 0 : 1) - (b.make === "Standard" ? 0 : 1)
      || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  if (!add.length) return tell("Every available sensor is already on this dashboard.");
  const note = state.supported ? "" : "\n\n(Not connected yet, so this is every sensor the app knows.)";
  if (!(await ask(`Add ${add.length} sensors to “${dash.name}”?${note}`, { ok: `Add ${add.length}` }))) return;
  for (const p of add) dash.widgets.push({ id: uid(), code: p.code, type: "number", size: 1, min: null, max: null, warn: null });
  save(); renderGrid(); subscribe();
};
$("#renameDashBtn").onclick = async () => {
  const d = activeDash();
  const name = await ask("Rename dashboard", { input: d.name, ok: "Rename" });
  if (name) { d.name = name; save(); renderTabs(); }
};
$("#deleteDashBtn").onclick = async () => {
  if (state.dashboards.length === 1) return tell("You need at least one dashboard.");
  if (!(await ask(`Delete “${activeDash().name}”?`, { ok: "Delete", danger: true }))) return;
  state.dashboards = state.dashboards.filter((d) => d.id !== state.active);
  save();
  state.active = state.dashboards[0].id;   // before re-rendering, or it draws the deleted one
  setEditing(false);
  switchDash(state.active);
};

// ---------------------------------------------------------------- settings menu

function fillSourceForm(cfg) {
  if (window.OBD_PHONE_MODE && !window.OBDNativeTcp?.available) {
    $("#carLabel").textContent = "OBD2 adapter (Bluetooth)";
    $("#hostRow").hidden = true;
  }
  if ($("#menuDlg").open) return;
  document.querySelectorAll("input[name=mode]").forEach((r) => (r.checked = r.value === cfg.mode));
  $("#obdHost").value = cfg.host;
  $("#obdPort").value = cfg.port;
}

$("#menuBtn").onclick = () => {
  document.querySelectorAll("input[name=units]").forEach((r) => (r.checked = r.value === state.units));
  $("#dtcOut").textContent = "";
  $("#misfireOut").textContent = "";
  $("#probeOut").textContent = "";
  $("#bodyDtcOut").textContent = "";
  loadVehicles();
  renderTrips();
  showLocationHelp();
  loadCustom().then(renderCustomList);
  $("#menuDlg").showModal();
};
document.querySelectorAll("input[name=units]").forEach((r) => (r.onchange = () => {
  state.units = r.value;
  localStorage.setItem("units", r.value);
  renderGrid();
}));
$("#applySource").onclick = async () => {
  const mode = document.querySelector("input[name=mode]:checked")?.value || "car";
  state.supported = null;
  await fetch("api/config", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, host: $("#obdHost").value, port: $("#obdPort").value }) });
  $("#menuDlg").close();
};
$("#newDashBtn").onclick = newDashboard;
$("#dtcBtn").onclick = async () => {
  const out = $("#dtcOut");
  out.textContent = "Reading…";
  try {
    const r = await fetch("api/dtcs");
    if (!r.ok) throw new Error(await r.text());
    const { codes } = await r.json();
    out.innerHTML = codes.length
      ? codes.map((c) => `<code>${c}</code>`).join("") + ` <span class="muted small">Look these up for your make/model.</span>`
      : "No stored trouble codes.";
  } catch (e) { out.textContent = "Couldn’t read codes: " + e.message; }
};

// "O2 sensor 3 voltage" -> "O2 bank 2 sensor 1 voltage (#3)", from the car's own layout (PID 13/1D).
function nameO2Sensors(positions = state.o2 || {}) {
  for (const p of Object.values(state.pids)) {
    if (p.make !== "Standard") continue;
    p.baseName ??= p.name;
    const m = p.baseName.match(/^O2 sensor (\d) (.*)$/);
    if (m && positions[m[1]]) p.name = `O2 ${positions[m[1]]} ${m[2]} (#${m[1]})`;
  }
}

// ---------------------------------------------------------------- vehicle profile

async function loadVehicles(data) {
  data ||= await (await fetch("api/vehicles")).json();
  state.profiles = data.profiles;
  state.vehicle = data.selected;
  state.checked = data.checked || {};
  const sel = $("#vehicleSel");
  sel.innerHTML = `<option value="">Any car (show every factory sensor)</option>` +
    data.profiles.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
  sel.value = state.vehicle || "";
  $("#vehicleAbout").textContent = data.profiles.find((p) => p.id === state.vehicle)?.about || "";
}
$("#vehicleSel").onchange = async (e) => {
  const r = await fetch("api/vehicle", { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: e.target.value || null }) });
  await loadVehicles(await r.json());
  $("#probeOut").textContent = "";
  renderGrid();
};
$("#probeBtn").onclick = async () => {
  const out = $("#probeOut");
  out.textContent = "Asking the car… (about a second per sensor)";
  try {
    const r = await fetch("api/probe", { method: "POST" });
    if (!r.ok) throw new Error(await r.text());
    const { checked } = await r.json();
    state.checked = checked;
    const yes = Object.keys(checked).filter((c) => checked[c]).map((c) => state.pids[c]?.name || c);
    const total = Object.keys(checked).length;
    out.innerHTML = yes.length
      ? `<b>${yes.length} of ${total}</b> answered: ${yes.map((n) => `<code>${n.replace(/</g, "&lt;")}</code>`).join(" ")}<p class="muted small">Those are now marked ✓ in Add sensor; the rest are hidden. A sensor that answers can still need its formula checked against a known gauge.</p>`
      : `None of the ${total} factory sensors answered. The standard sensors still work.`;
    renderGrid();
  } catch (e) { out.textContent = "Couldn’t check: " + e.message; }
};

$("#bodyDtcBtn").onclick = async () => {
  const out = $("#bodyDtcOut");
  out.textContent = "Asking the body module…";
  try {
    const r = await fetch("api/module-dtcs?module=body");
    if (!r.ok) throw new Error(await r.text());
    const { answered, codes } = await r.json();
    if (!answered) {
      out.textContent = "The body module didn’t answer. On older cars (like a 2007 Mustang or 2012 Mazda 6) it isn’t reachable from the OBD port, or doesn’t watch the bulbs.";
      return;
    }
    out.innerHTML = codes.length
      ? codes.map((c) => `<div><code>${c.code}-${c.type}</code> ${c.meaning}${c.active ? " · <b>happening now</b>" : ""}</div>`).join("")
        + `<p class="muted small">Look the code up for your vehicle to see which lamp it is. Codes ending in -13 (open circuit) usually mean a bulb is out. Lamps are only checked while they're switched on, so turn on the lights, press the brake and use each signal first.</p>`
      : "No body module codes stored. Lamps are only checked while they’re on, so switch on the lights, press the brake and use each signal, then check again.";
  } catch (e) { out.textContent = "Couldn’t read: " + e.message; }
};

$("#misfireBtn").onclick = async () => {
  const out = $("#misfireOut");
  out.textContent = "Reading…";
  try {
    const r = await fetch("api/misfires");
    if (!r.ok) throw new Error(await r.text());
    const m = await r.json();
    if (!m.supported || !m.cylinders.length) {
      out.textContent = "This car doesn’t report misfires per cylinder over OBD2 (or the monitor hasn’t run yet).";
      return;
    }
    const n = (v) => (v == null ? "–" : v);
    const rows = m.cylinders.map((c) => `<tr${c.this_drive || c.avg_last_10 ? ' class="warn"' : ""}><td>Cylinder ${c.cyl}</td><td>${n(c.this_drive)}</td><td>${n(c.avg_last_10)}</td></tr>`);
    if (m.total) rows.push(`<tr><td><b>All</b></td><td>${n(m.total.this_drive)}</td><td>${n(m.total.avg_last_10)}</td></tr>`);
    out.innerHTML = `<table class="sensors"><tr><th></th><th>This drive</th><th>Avg, last 10 drives</th></tr>${rows.join("")}</table>
      <p class="muted small">Counts reset when codes are cleared or the battery is disconnected. The car fills these in as it drives.</p>`;
  } catch (e) { out.textContent = "Couldn’t read misfires: " + e.message; }
};

// ---------------------------------------------------------------- custom sensors + test console

let customSensors = [];
let editingCustom = null;

async function loadCustom() {
  customSensors = await (await fetch("api/custom-sensors")).json();
}

async function reloadPids() {
  const pids = await (await fetch("api/pids")).json();
  state.pids = {};
  for (const p of pids) state.pids[p.code] = p;
  nameO2Sensors();
}

function renderCustomList() {
  const box = $("#customList");
  box.innerHTML = customSensors.length ? "" : `<span class="muted small">None yet.</span>`;
  for (const c of customSensors) {
    const row = document.createElement("div");
    row.className = "trip";
    row.innerHTML = `<div class="info"><span></span><small></small></div>
      <button type="button">Edit</button><button type="button" class="danger">Delete</button>`;
    row.querySelector("span").textContent = c.name;
    row.querySelector("small").textContent = `${c.header || "all"} · ${c.cmd} · ${c.formula}`;
    const [edit, del] = row.querySelectorAll("button");
    edit.onclick = () => openCustomDialog(c);
    del.onclick = async () => {
      if (!(await ask(`Delete “${c.name}”? It will disappear from your dashboards.`, { ok: "Delete", danger: true }))) return;
      customSensors = customSensors.filter((x) => x !== c);
      await saveCustom();
    };
    box.append(row);
  }
}

async function saveCustom() {
  const r = await fetch("api/custom-sensors", { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(customSensors) });
  if (!r.ok) throw new Error(await r.text());
  await reloadPids();
  renderCustomList();
  renderGrid();
  subscribe();
}

const CUSTOM_FIELDS = ["name", "unit", "header", "cmd", "formula", "min", "max"];

function openCustomDialog(c = null) {
  editingCustom = c;
  for (const f of CUSTOM_FIELDS) $("#c_" + f).value = c?.[f] ?? "";
  if (!c) { $("#c_formula").value = "A"; $("#c_min").value = 0; $("#c_max").value = 100; }
  $("#customOut").textContent = "";
  $("#customErr").textContent = "";
  $("#customDlg").showModal();
}

function customForm() {
  const d = {};
  for (const f of CUSTOM_FIELDS) d[f] = $("#c_" + f).value.trim();
  return d;
}

async function sendRaw(body, out) {
  out.textContent = "Asking the car…";
  try {
    const r = await fetch("api/raw", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body) });
    if (!r.ok) throw new Error(await r.text());
    const { reply, value } = await r.json();
    out.textContent = `Reply: ${reply || "(nothing)"}` + (value != null ? `\nValue: ${value}` :
      body.formula ? "\nValue: no usable reply" : "");
  } catch (e) { out.textContent = "Error: " + e.message; }
}

$("#customTest").onclick = () => sendRaw(customForm(), $("#customOut"));
$("#customSave").onclick = async () => {
  const d = customForm();
  if (!d.name || !d.cmd) { $("#customErr").textContent = "Name and command are needed."; return; }
  const before = customSensors.slice();
  if (editingCustom) Object.assign(editingCustom, d);
  else customSensors.push({ code: "custom_" + uid(), category: "Custom", ...d });
  try {
    await saveCustom();
    $("#customDlg").close();
    if ($("#widgetDlg").open) { renderMakeChips(); renderPidList($("#pidSearch").value); }
  } catch (e) {
    customSensors = before;
    if (editingCustom) await loadCustom();
    $("#customErr").textContent = e.message;
  }
};
$("#addCustomBtn").onclick = () => openCustomDialog();
$("#newCustomFromPicker").onclick = () => openCustomDialog();
$("#consoleSend").onclick = () => sendRaw({ cmd: $("#consoleCmd").value, header: $("#consoleHeader").value },
  $("#consoleOut"));

// ---------------------------------------------------------------- trip recording

function setRecording(on) {
  state.recording = on;
  $("#recBtn").classList.toggle("on", on);
  $("#recBtn").title = on ? "Recording. Tap to stop." : "Record this trip to the database";
  on ? startGps() : stopGps();
}

// ---------------------------------------------------------------- GPS (where each reading was taken)

let gpsWatch = null;
let lastFixSent = 0;

function gpsLabel(text) {
  $("#recBtn").textContent = text ? `● REC · ${text}` : "● REC";
}

function startGps() {
  if (gpsWatch !== null) return;
  // Raspberry Pi with a USB GPS: the server records positions itself.
  const serverGps = state.status.config?.gps;
  if (serverGps != null) { gpsLabel(serverGps === "fix" ? "GPS" : "no GPS fix"); return; }
  if (!window.isSecureContext || !navigator.geolocation) {
    gpsLabel(state.recording ? "no GPS" : "");
    return;
  }
  gpsLabel("GPS…");
  gpsWatch = navigator.geolocation.watchPosition((pos) => {
    const now = Date.now();
    if (now - lastFixSent < 1000) return;   // at most one fix per second
    lastFixSent = now;
    const c = pos.coords;
    gpsLabel("GPS");
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: "location", t: pos.timestamp / 1000, lat: c.latitude, lon: c.longitude,
        acc: c.accuracy, speed: c.speed, heading: c.heading }));
    }
  }, (err) => {
    gpsLabel(err.code === 1 ? "GPS blocked" : "no GPS");
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
}

function stopGps() {
  if (gpsWatch !== null) navigator.geolocation.clearWatch(gpsWatch);
  gpsWatch = null;
  gpsLabel("");
}

async function showLocationHelp() {
  const box = $("#gpsHelp");
  let info = {};
  try { info = await (await fetch("api/info")).json(); } catch {}
  if (info.app) $("#dbPath").textContent = "Saved on this tablet, inside the app. Uninstalling the app deletes it, so save a CSV of trips you want to keep (they go to the Download folder).";
  else if (info.phone) $("#dbPath").textContent = "Saved on this phone, in this browser's storage. Download a CSV to keep a copy elsewhere.";
  else if (info.db_path) $("#dbPath").textContent = `Saved in ${info.db_path} on ${info.host}.`;
  if (window.isSecureContext) { box.hidden = true; return; }
  box.hidden = false;
  if (info.https_port) {
    const url = `https://${location.hostname}:${info.https_port}/`;
    box.innerHTML = `Location is only available on the secure address. First time: install the
      <a href="ca.crt">certificate</a> (see README), then open <a href="${url}">${url}</a>.`;
  } else {
    box.textContent = "Location needs HTTPS. Start the server with --iphone (start-iphone.bat) to record where readings were taken.";
  }
}

$("#recBtn").onclick = async () => {
  await fetch("api/recording", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ on: !state.recording }) });
  if ($("#menuDlg").open) renderTrips();
};

function duration(s) {
  s = Math.round(s);
  return s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`
    : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`;
}

async function renderTrips() {
  const list = $("#tripList");
  const { recording, trips } = await (await fetch("api/trips")).json();
  list.innerHTML = trips.length ? "" : `<span class="muted small">No trips recorded yet.</span>`;
  for (const t of trips) {
    const row = document.createElement("div");
    row.className = "trip";
    const live = t.id === recording;
    const len = live ? "recording now" : duration((t.ended || t.started) - t.started);
    row.innerHTML = `<div class="info"><span></span><small></small></div>
      <a href="map.html?trip=${t.id}">Map</a><a href="api/trips/${t.id}.csv" download>CSV</a><button type="button" class="danger">Delete</button>`;
    row.querySelector("span").textContent = t.name;
    row.querySelector("small").textContent = `${len} · ${t.n.toLocaleString()} readings · ` +
      (t.n_gps ? `${t.n_gps.toLocaleString()} locations` : "no locations");
    row.querySelector("button").onclick = async () => {
      if (!(await ask(`Delete “${t.name}”?`, { ok: "Delete", danger: true }))) return;
      await fetch(`api/trips/${t.id}`, { method: "DELETE" });
      renderTrips();
    };
    list.append(row);
  }
}

// ---------------------------------------------------------------- start

(async function init() {
  const pids = await (await fetch("api/pids")).json();
  for (const p of pids) state.pids[p.code] = p;
  try { await loadVehicles(); } catch {}
  await loadDashboards();
  renderTabs();
  renderGrid();
  connect();
  addEventListener("resize", () => { for (const w of state.widgets.values()) w.update(); });
  // Not in the Android app: its files are already on the tablet, and a cache would hide app updates.
  if ("serviceWorker" in navigator && !window.Capacitor?.isNativePlatform?.()) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
