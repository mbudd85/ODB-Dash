// On-phone database (IndexedDB): settings, dashboards, custom sensors, trips,
// readings and GPS locations. Same data as the server's obd.db.
"use strict";

class Store {
  static open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("obd-dash", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("kv");
        db.createObjectStore("trips", { keyPath: "id", autoIncrement: true });
        db.createObjectStore("readings", { autoIncrement: true }).createIndex("trip", "trip_id");
        db.createObjectStore("locations", { autoIncrement: true }).createIndex("trip", "trip_id");
      };
      req.onsuccess = () => resolve(new Store(req.result));
      req.onerror = () => reject(req.error);
    });
  }

  constructor(db) {
    this.db = db;
    this.tripId = null;
    // Ask the browser not to clear this data when space is low.
    navigator.storage?.persist?.().catch(() => {});
  }

  _req(storeNames, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeNames, mode);
      let result;
      Promise.resolve(fn(tx)).then((r) => { result = r; });
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  static wrap(req) {
    return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  }

  // ---- key/value
  get(key) { return this._req("kv", "readonly", (tx) => Store.wrap(tx.objectStore("kv").get(key))); }
  set(key, value) { return this._req("kv", "readwrite", (tx) => { tx.objectStore("kv").put(value, key); }); }

  // ---- trips
  get recording() { return this.tripId !== null; }

  async init() {
    // Close any trip left open when the app was closed mid-drive.
    const trips = await this.allTrips();
    for (const t of trips.filter((t) => t.ended == null)) {
      t.ended = t.last || t.started;
      await this._req("trips", "readwrite", (tx) => { tx.objectStore("trips").put(t); });
    }
  }

  async startTrip(name) {
    if (this.tripId !== null) return this.tripId;
    const now = Date.now() / 1000;
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    name ||= `Trip ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    this.tripId = await this._req("trips", "readwrite", (tx) =>
      Store.wrap(tx.objectStore("trips").add({ name, started: now, ended: null, last: now, n: 0, n_gps: 0 })));
    return this.tripId;
  }

  async stopTrip() {
    if (this.tripId === null) return;
    const id = this.tripId;
    this.tripId = null;
    await this._bump(id, (t) => { t.ended = Date.now() / 1000; });
  }

  _bump(id, fn) {
    return this._req("trips", "readwrite", async (tx) => {
      const s = tx.objectStore("trips");
      const t = await Store.wrap(s.get(id));
      if (t) { fn(t); s.put(t); }
    });
  }

  async log(t, values) {
    if (this.tripId === null) return;
    const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v != null));
    if (!Object.keys(clean).length) return;
    const id = this.tripId;
    await this._req(["readings", "trips"], "readwrite", async (tx) => {
      tx.objectStore("readings").add({ trip_id: id, t, values: clean });
      const s = tx.objectStore("trips");
      const trip = await Store.wrap(s.get(id));
      if (trip) { trip.n += Object.keys(clean).length; trip.last = t; s.put(trip); }
    });
  }

  async logLocation(loc) {
    if (this.tripId === null) return;
    const id = this.tripId;
    await this._req(["locations", "trips"], "readwrite", async (tx) => {
      tx.objectStore("locations").add({ trip_id: id, ...loc });
      const s = tx.objectStore("trips");
      const trip = await Store.wrap(s.get(id));
      if (trip) { trip.n_gps += 1; s.put(trip); }
    });
  }

  allTrips() { return this._req("trips", "readonly", (tx) => Store.wrap(tx.objectStore("trips").getAll())); }

  async trips() { return (await this.allTrips()).sort((a, b) => b.started - a.started); }

  _byTrip(store, id) {
    return this._req(store, "readonly", (tx) =>
      Store.wrap(tx.objectStore(store).index("trip").getAll(IDBKeyRange.only(id)))).then((rows) => rows.sort((a, b) => a.t - b.t));
  }
  readings(id) { return this._byTrip("readings", id); }
  locations(id) { return this._byTrip("locations", id); }

  async deleteTrip(id) {
    if (id === this.tripId) this.tripId = null;
    await this._req(["trips", "readings", "locations"], "readwrite", async (tx) => {
      tx.objectStore("trips").delete(id);
      for (const name of ["readings", "locations"]) {
        const idx = tx.objectStore(name).index("trip");
        const keys = await Store.wrap(idx.getAllKeys(IDBKeyRange.only(id)));
        for (const k of keys) tx.objectStore(name).delete(k);
      }
    });
  }

  // Each GPS point with the latest reading of every sensor at that moment (same as db.py).
  async track(id) {
    const readings = await this.readings(id);
    const points = [], latest = {};
    let i = 0;
    for (const loc of await this.locations(id)) {
      while (i < readings.length && readings[i].t <= loc.t) {
        for (const [c, v] of Object.entries(readings[i].values)) latest[c] = [readings[i].t, v];
        i++;
      }
      const values = {};
      for (const [c, [t, v]] of Object.entries(latest)) if (loc.t - t <= 10) values[c] = v;
      points.push({ t: loc.t, lat: loc.lat, lon: loc.lon, acc: loc.acc, speed: loc.speed, values });
    }
    return points;
  }

  async csv(id, names) {
    const readings = await this.readings(id);
    const locs = await this.locations(id);
    const codes = [...new Set(readings.flatMap((r) => Object.keys(r.values)))].sort();
    const esc = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);
    const lines = [["time", "latitude", "longitude", ...codes.map((c) => names[c] || c)].map(esc).join(",")];
    let j = 0;
    for (const r of readings) {
      while (j + 1 < locs.length && Math.abs(locs[j + 1].t - r.t) <= Math.abs(locs[j].t - r.t)) j++;
      const loc = locs[j] && Math.abs(locs[j].t - r.t) <= 10 ? locs[j] : null;
      const d = new Date(r.t * 1000);
      const stamp = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 23);
      lines.push([stamp, loc ? loc.lat : "", loc ? loc.lon : "", ...codes.map((c) => r.values[c] ?? "")].join(","));
    }
    return lines.join("\n") + "\n";
  }
}
