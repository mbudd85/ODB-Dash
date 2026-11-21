// Phone mode: everything the Python server did, running inside the page.
// It answers the app's "api/..." requests and its WebSocket locally, so the
// same dashboard UI works with no server at all.
"use strict";

(() => {
  const realFetch = window.fetch.bind(window);
  const listeners = new Set();   // fake WebSocket connections (one per open page)
  let store, registry, elm = null, loopToken = 0;
  let config = { mode: "sim" };
  let status = { state: "idle", message: "" };
  let wanted = new Set(), recordCodes = new Set();
  let bleDevice = null;
  const ready = (async () => {
    store = await Store.open();
    await store.init();
    registry = new Registry();
    registry.setCustom((await store.get("custom_sensors")) || []);
    config = { ...config, ...((await store.get("config")) || {}) };
  })();

  // ------------------------------------------------------------ status + data out

  const fullConfig = () => ({ ...config, recording: store?.recording || false, transport: transportName() });
  function transportName() {
    if (config.mode === "sim") return "simulator";
    if (window.OBDNativeTcp?.available) return "wifi";
    return "bluetooth";
  }
  function emit(msg) {
    const data = JSON.stringify(msg);
    for (const ws of listeners) ws._deliver(data);
  }
  function setStatus(s) { status = s; emit({ type: "status", ...s, config: fullConfig() }); }

  // ------------------------------------------------------------ connection loop

  async function makeTransport() {
    if (config.mode === "sim") return new SimTransport();
    if (window.OBDNativeTcp?.available) return new window.OBDNativeTcp(config.host || "192.168.0.10", +config.port || 35000);
    if (!BleTransport.available) throw new Error("This browser has no Bluetooth. On iPhone, open the app in Bluefy.");
    if (!bleDevice) throw Object.assign(new Error("Tap here to pick your Bluetooth OBD2 adapter."), { needsTap: true });
    return new BleTransport(bleDevice);
  }

  async function run(token) {
    while (token === loopToken) {
      const where = config.mode === "sim" ? "simulator" : transportName() === "wifi" ? `${config.host || "192.168.0.10"}` : (bleDevice?.name || "Bluetooth adapter");
      try {
        const t = await makeTransport();
        elm = new Elm327(t, registry);
        setStatus({ state: "connecting", message: `Connecting to ${where}…` });
        await elm.connect();
        if (token !== loopToken) { await elm.close(); return; }
        setStatus({ state: "connected", message: `Connected to ${where}`, version: elm.version,
          protocol: elm.protocol, supported: ["RV", ...[...elm.supported].sort()] });
        await poll(token);
      } catch (e) {
        try { await elm?.close(); } catch {}
        elm = null;
        if (token !== loopToken) return;
        if (e.needsTap) { setStatus({ state: "error", message: e.message, needsTap: true }); return; }
        setStatus({ state: "error", message: `${where}: ${e.message}. Retrying in 5 s.` });
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  async function poll(token) {
    let failures = 0;
    while (token === loopToken) {
      const codes = [...new Set([...wanted, ...(store.recording ? recordCodes : [])])].sort();
      if (!codes.length) { await new Promise((r) => setTimeout(r, 200)); continue; }
      const start = performance.now();
      const values = {};
      for (const code of codes) {
        const s = registry.get(code);
        if (code !== "RV" && !s) continue;
        if (s && s.standard && elm.supported.size && !elm.supported.has(code)) continue;
        try { values[code] = await elm.read(code); failures = 0; }
        catch (e) {
          if (!e.timeout) throw e;
          if (++failures >= 5) throw new Error("adapter stopped responding");
        }
        if (token !== loopToken) return;
      }
      const secs = (performance.now() - start) / 1000;
      const now = Date.now() / 1000;
      store.log(now, values).catch(() => {});
      emit({ type: "data", values, t: now, rate: Math.round((codes.length / (secs || 1)) * 10) / 10 });
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async function restart() {
    loopToken++;
    try { await elm?.close(); } catch {}
    elm = null;
    run(loopToken);
  }

  // ------------------------------------------------------------ fake WebSocket

  class LocalSocket {
    static OPEN = 1;
    constructor() {
      this.readyState = 0;
      listeners.add(this);
      ready.then(() => {
        this.readyState = 1;
        this.onopen?.();
        this._deliver(JSON.stringify({ type: "status", ...status, config: fullConfig() }));
      });
    }
    _deliver(data) { if (this.readyState === 1) setTimeout(() => this.onmessage?.({ data }), 0); }
    send(text) {
      const m = JSON.parse(text);
      if (m.type === "subscribe") wanted = new Set(m.codes || []);
      else if (m.type === "location") {
        store.logLocation({ t: m.t || Date.now() / 1000, lat: +m.lat, lon: +m.lon, acc: m.acc, speed: m.speed, heading: m.heading }).catch(() => {});
      }
    }
    close() { this.readyState = 3; listeners.delete(this); }
  }
  const RealWS = window.WebSocket;
  window.WebSocket = function (url) { return /\/ws$/.test(url) ? new LocalSocket() : new RealWS(url); };
  window.WebSocket.OPEN = 1;

  // ------------------------------------------------------------ fake API

  const json = (data, statusCode = 200) => new Response(JSON.stringify(data), { status: statusCode, headers: { "Content-Type": "application/json" } });
  const text = (t, statusCode) => new Response(t, { status: statusCode });
  const names = () => Object.fromEntries(registry.catalog().map((p) => [p.code, `${p.name} (${p.unit})`]));

  const routes = [
    ["GET", /^pids$/, () => json(registry.catalog())],
    ["GET", /^dashboards$/, async () => json((await store.get("dashboards")) ?? null)],
    ["PUT", /^dashboards$/, async (b) => { await store.set("dashboards", b); return json({ ok: true }); }],
    ["GET", /^config$/, () => json(fullConfig())],
    ["POST", /^config$/, (b) => {
      config = { mode: b.mode === "sim" ? "sim" : "car", host: b.host || config.host, port: b.port || config.port };
      store?.set("config", config).catch(() => {});   // no await: keep the tap's permission for the Bluetooth picker
      return connectNow();
    }],
    ["POST", /^connect$/, () => connectNow()],
    ["GET", /^info$/, () => json({ phone: true, db_path: "this phone (browser storage)", host: "your phone" })],
    ["GET", /^custom-sensors$/, async () => json((await store.get("custom_sensors")) || [])],
    ["PUT", /^custom-sensors$/, async (b) => {
      try { b.forEach((d) => customSensor(d)); } catch (e) { return text(e.message, 400); }
      await store.set("custom_sensors", b);
      registry.setCustom(b);
      return json({ ok: true });
    }],
    ["POST", /^raw$/, async (d) => {
      if (status.state !== "connected") return text("Not connected to the adapter", 503);
      const cmd = (d.cmd || "").toUpperCase().replace(/\s/g, "");
      try {
        if (cmd.startsWith("AT")) {
          if (!["ATRV", "ATDP", "ATDPN", "ATI"].includes(cmd)) throw new Error("only ATRV, ATDP, ATDPN and ATI are allowed here");
          return json({ reply: await elm.raw(cmd, null), value: null });
        }
        const s = customSensor({ ...d, code: "custom_test", cmd });
        const reply = await elm.raw(cmd, s.header);
        const value = d.formula ? await elm.readSensor(s) : null;
        return json({ reply, value });
      } catch (e) { return text(e.message, 400); }
    }],
    ["GET", /^dtcs$/, async () => {
      if (status.state !== "connected") return text("Not connected to the adapter", 503);
      return json({ codes: await elm.readDtcs() });
    }],
    ["GET", /^trips$/, async () => json({ recording: store.tripId, trips: await store.trips() })],
    ["POST", /^recording$/, async (b) => {
      if (b.on) { recordCodes = new Set(wanted); await store.startTrip(b.name); } else await store.stopTrip();
      emit({ type: "status", ...status, config: fullConfig() });
      return json({ recording: store.tripId });
    }],
    ["GET", /^trips\/(\d+)\/track$/, async (b, m) => {
      const id = +m[1];
      const trip = (await store.trips()).find((t) => t.id === id);
      if (!trip) return text("No such trip", 404);
      return json({ trip, points: await store.track(id) });
    }],
    ["GET", /^trips\/(\d+)\.csv$/, async (b, m) => new Response(await store.csv(+m[1], names()), { headers: { "Content-Type": "text/csv" } })],
    ["DELETE", /^trips\/(\d+)$/, async (b, m) => { await store.deleteTrip(+m[1]); return json({ ok: true }); }],
  ];

  function connectNow() {
    // Bluetooth needs the device picker opened directly from the tap, before any await.
    if (config.mode !== "sim" && !window.OBDNativeTcp?.available && BleTransport.available) {
      return BleTransport.requestDevice().then((d) => { bleDevice = d; restart(); return json(fullConfig()); },
        (e) => { setStatus({ state: "error", message: `No adapter picked (${e.message}). Tap here to try again.`, needsTap: true }); return json(fullConfig()); });
    }
    restart();
    return json(fullConfig());
  }

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const path = url.pathname.replace(/^.*?\/api\//, "");
    if (!url.pathname.includes("/api/")) return realFetch(input, init);
    const method = (init.method || "GET").toUpperCase();
    for (const [m, re, fn] of routes) {
      const match = method === m && path.match(re);
      if (!match) continue;
      // Bluetooth picker must open synchronously within the tap, so don't await `ready` first for it.
      if (re.source.includes("connect") || re.source.includes("config")) {
        if (method === "POST") { const body = init.body ? JSON.parse(init.body) : {}; return fn(body, match); }
      }
      await ready;
      return fn(init.body ? JSON.parse(init.body) : {}, match);
    }
    return text("Not found", 404);
  };

  // CSV links: build the file on the phone, then share or download it.
  document.addEventListener("click", async (e) => {
    const a = e.target.closest?.("a[href*='api/trips/'][download]");
    if (!a) return;
    e.preventDefault();
    const res = await window.fetch(a.getAttribute("href"));
    const file = new File([await res.text()], a.getAttribute("href").split("/").pop().replace(/^(\d+)/, "trip-$1"), { type: "text/csv" });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: file.name }); return; } catch (err) { if (err.name === "AbortError") return; }
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(file);
    link.download = file.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  }, true);

  // Start: the simulator connects by itself; Bluetooth waits for a tap.
  ready.then(() => {
    if (window.OBD_NO_CONNECT) return;   // e.g. the map page only reads saved trips
    if (config.mode === "sim" || window.OBDNativeTcp?.available) restart();
    else setStatus({ state: "error", message: BleTransport.available ? "Tap here to pick your Bluetooth OBD2 adapter."
      : "This browser has no Bluetooth. On iPhone, open the app in Bluefy, or use the simulator (☰).", needsTap: BleTransport.available });
  });
  window.OBD_PHONE_MODE = true;
})();
