// ELM327 protocol in the browser. Port of obd/elm327.py.
// A transport is any object with open(), close(), send(cmd, timeoutMs) -> reply text.
"use strict";

const INIT_COMMANDS = ["ATZ", "ATE0", "ATL0", "ATS0", "ATH0", "ATSP0"];
const NO_DATA = ["NODATA", "UNABLETOCONNECT", "CANERROR", "BUSERROR", "STOPPED", "ERROR", "?"];
const BLOCKED_SERVICES = ["04", "14", "11", "2E", "2F", "31", "3B"];  // clear codes / write / reset

class Sensor {
  constructor(d) {
    Object.assign(this, d);
    this.cmd = (d.cmd || "01" + d.code).toUpperCase().replace(/\s/g, "");
    this.header = d.header ? d.header.toUpperCase().replace(/\s/g, "") : null;
    this.decode = OBDFormula.compile(d.formula || "A");
  }
  get standard() { return this.make === "Standard"; }
  get replyPrefix() {
    return (parseInt(this.cmd.slice(0, 2), 16) + 0x40).toString(16).toUpperCase().padStart(2, "0") + this.cmd.slice(2);
  }
}

function customSensor(d) {
  const code = d.code || "";
  if (!code.startsWith("custom_")) throw new Error("custom sensor codes start with custom_");
  const cmd = (d.cmd || "").toUpperCase().replace(/\s/g, "");
  if (BLOCKED_SERVICES.includes(cmd.slice(0, 2)))
    throw new Error("that command changes the car (clear codes / write / reset), so it's not allowed");
  if (cmd.length < 4 || cmd.length % 2 || !/^[0-9A-F]+$/.test(cmd)) throw new Error("command must be hex, e.g. 221E1C");
  const header = (d.header || "").toUpperCase().replace(/\s/g, "") || null;
  if (header && (![3, 6, 8].includes(header.length) || !/^[0-9A-F]+$/.test(header)))
    throw new Error("header must be hex, e.g. 7E0");
  return new Sensor({
    code, name: d.name || cmd, unit: d.unit || "", min: +(d.min || 0), max: +(d.max || 100),
    formula: d.formula || "A", cmd, header, category: d.category || "Custom", make: "Custom",
    verified: false, note: d.note || "",
  });
}

class Registry {
  constructor() {
    this.sensors = new Map();
    this.errors = [];
    for (const d of OBD_SENSORS) {
      if (d.code === "RV") continue;
      try { this.sensors.set(d.code, new Sensor(d)); } catch (e) { this.errors.push(`${d.code}: ${e.message}`); }
    }
  }
  setCustom(items) {
    for (const [code, s] of this.sensors) if (s.make === "Custom") this.sensors.delete(code);
    for (const d of items) {
      try { const s = customSensor(d); this.sensors.set(s.code, s); } catch (e) { this.errors.push(`${d.name}: ${e.message}`); }
    }
  }
  get(code) { return this.sensors.get(code); }
  catalog() {
    const rv = OBD_SENSORS.find((d) => d.code === "RV");
    return [rv, ...[...this.sensors.values()].map((s) => {
      const { decode, ...rest } = s;
      return { ...rest, nbytes: decode.nbytes };
    })];
  }
}

function cleanReply(text) {
  return text.replace(/\n/g, "\r").split("\r").map((l) => l.trim()).filter(Boolean).join(" ");
}

function parseReply(reply, want) {
  let lines = reply.replace(/\n/g, "\r").split("\r").map((l) => l.trim().replace(/ /g, "").toUpperCase()).filter(Boolean);
  const frame = /^[0-9A-F]:/;
  if (lines.some((l) => frame.test(l))) lines = [lines.filter((l) => frame.test(l)).map((l) => l.slice(2)).join("")];
  for (const line of lines) {
    if (line.startsWith("SEARCHING") || line.startsWith("BUSINIT")) continue;
    if (NO_DATA.some((e) => line.startsWith(e)) || line.startsWith("7F")) return null;
    const i = line.indexOf(want);
    if (i >= 0) {
      let hex = line.slice(i + want.length);
      hex = hex.slice(0, Math.floor(hex.length / 2) * 2);
      if (!/^[0-9A-F]*$/.test(hex)) return null;
      const out = [];
      for (let k = 0; k < hex.length; k += 2) out.push(parseInt(hex.slice(k, k + 2), 16));
      return out;
    }
  }
  return null;
}

function parseDtcs(reply) {
  const s = reply.replace(/ /g, "").toUpperCase();
  const codes = [];
  for (const m of s.matchAll(/43([0-9A-F]+)/g)) {
    let chunk = m[1];
    if (chunk.length % 4 === 2) chunk = chunk.slice(2);
    for (let i = 0; i + 4 <= chunk.length; i += 4) {
      const w = chunk.slice(i, i + 4);
      if (w === "0000") continue;
      const first = parseInt(w[0], 16);
      codes.push("PCBU"[first >> 2] + String(first & 3) + w.slice(1));
    }
  }
  return codes;
}

class Elm327 {
  constructor(transport, registry) {
    this.t = transport;
    this.registry = registry;
    this.header = null;
    this.supported = new Set();
    this.version = "";
    this.protocol = "";
    this.o2Positions = {};   // sensor number 1-8 -> "bank 1 sensor 2"
    this.can = false;        // CAN (11 or 29 bit): allows the fast paths below
    this.multiOk = true;     // engine computer answers several PIDs in one request
    this._chain = Promise.resolve();
  }

  // Run fn exclusively, so a header change + request never interleaves with another.
  _locked(fn) {
    const run = this._chain.then(fn, fn);
    this._chain = run.catch(() => {});
    return run;
  }

  async connect() {
    await this.t.open();
    for (const cmd of INIT_COMMANDS) {
      const reply = await this.t.send(cmd, 10000);
      if (cmd === "ATZ") this.version = cleanReply(reply);
    }
    // First real query makes the adapter search for the car's protocol; that can take several seconds.
    await this.detectSupported();
    await this.detectO2Layout();
    this.protocol = cleanReply(await this.t.send("ATDP"));
    this.can = ["6", "7", "8", "9"].includes(cleanReply(await this.t.send("ATDPN")).slice(-1));
    if (this.can) await this.t.send("ATAT2");   // adaptive timing, aggressive: don't wait long after the reply
  }

  // Which O2 sensor number (PIDs 14-1B) is which bank/position, from PID 13 or 1D.
  async detectO2Layout() {
    this.o2Positions = {};
    for (const [pid, perBank] of [["13", 4], ["1D", 2]]) {
      if (!this.supported.has(pid)) continue;
      const data = await this.queryRaw(pid);
      if (!data || !data.length) continue;
      for (let i = 0; i < 8; i++) {
        if (data[0] & (1 << i)) this.o2Positions[i + 1] = `bank ${Math.floor(i / perBank) + 1} sensor ${(i % perBank) + 1}`;
      }
      break;
    }
  }

  queryRaw(pid, timeoutMs) {
    return this._locked(async () => {
      await this.setHeader(null);
      return parseReply(await this.t.send("01" + pid, timeoutMs), "41" + pid);
    });
  }

  async close() { await this.t.close(); }

  async setHeader(header) {
    if (header === this.header) return;
    const reply = await this.t.send("ATSH" + (header || "7DF"));
    if (reply.includes("?")) throw new Error(`adapter rejected header ${header}`);
    this.header = header;
  }

  async detectSupported() {
    this.supported = new Set();
    let base = 0;
    for (;;) {
      const pid = base.toString(16).toUpperCase().padStart(2, "0");
      const data = await this.queryRaw(pid, 15000);
      if (!data || data.length < 4) break;
      const mask = ((data[0] << 24) >>> 0) + (data[1] << 16) + (data[2] << 8) + data[3];
      for (let i = 0; i < 32; i++) {
        if (mask & (2 ** (31 - i))) this.supported.add((base + i + 1).toString(16).toUpperCase().padStart(2, "0"));
      }
      const next = base + 0x20;
      if (!this.supported.has(next.toString(16).toUpperCase().padStart(2, "0")) || next > 0xC0) break;
      base = next;
    }
  }

  async read(code) {
    if (code === "RV") {
      const m = (await this._locked(() => this.t.send("ATRV"))).match(/(\d+(?:\.\d+)?)\s*V/);
      return m ? parseFloat(m[1]) : null;
    }
    const s = this.registry.get(code);
    return s ? this.readSensor(s) : null;
  }

  async readSensor(s) {
    let cmd = s.cmd, header = s.header;
    if (this.can) {
      if (s.standard) header = "7E0";                          // ask only the engine computer, so one reply
      if (cmd.length / 2 + s.decode.nbytes <= 7) cmd += "1";   // "expect 1 reply": answer comes back at once
    }
    const reply = await this._locked(async () => {
      await this.setHeader(header);
      return this.t.send(cmd);
    });
    const data = parseReply(reply, s.replyPrefix);
    if (!data || data.length < s.decode.nbytes) return null;
    return round3(s.decode(data));
  }

  // Several mode 01 PIDs, up to 6 per request on CAN cars (much faster than one by one).
  async readStandard(codes) {
    let sensors = codes.map((c) => this.registry.get(c)).filter(Boolean);
    const out = {};
    // Only PIDs with a known reply length can share a request (otherwise the reply can't be split).
    const single = this.can && this.multiOk ? sensors.filter((s) => !(s.code in OBD_PID_LENGTHS)) : sensors;
    for (const s of single) out[s.code] = await this.readSensor(s);
    sensors = sensors.filter((s) => !single.includes(s));
    for (let i = 0; i < sensors.length; i += 6) {
      const group = sensors.slice(i, i + 6);
      if (group.length === 1) { out[group[0].code] = await this.readSensor(group[0]); continue; }
      const size = 1 + group.reduce((n, s) => n + 1 + OBD_PID_LENGTHS[s.code], 0);
      const frames = size <= 7 ? 1 : 1 + Math.ceil((size - 6) / 7);
      const cmd = "01" + group.map((s) => s.code).join("") + (frames <= 15 ? frames.toString(16).toUpperCase() : "");
      const reply = await this._locked(async () => {
        await this.setHeader("7E0");
        return this.t.send(cmd);
      });
      const got = parseMulti(reply, Object.fromEntries(group.map((s) => [s.code, s])));
      if (!Object.keys(got).length) {
        this.multiOk = false;   // not answered: read one at a time from now on
        for (const s of group) out[s.code] = await this.readSensor(s);
        continue;
      }
      for (const s of group) out[s.code] = got[s.code] ?? null;
    }
    return out;
  }

  raw(cmd, header) {
    return this._locked(async () => {
      await this.setHeader(header || null);
      return cleanReply(await this.t.send(cmd, 10000));
    });
  }

  async readDtcs() {
    const reply = await this._locked(async () => {
      await this.setHeader(null);
      return cleanReply(await this.t.send("03", 10000));
    });
    return parseDtcs(reply);
  }

  // Trouble codes stored in another module (UDS service 19 = read only), e.g. the body
  // module (726 on Fords), which logs burned-out bulbs. null = module didn't answer.
  async readModuleDtcs(header) {
    const reply = await this._locked(async () => {
      await this.setHeader(header);
      return this.t.send("19020D", 5000);
    });
    return parseUdsDtcs(reply);
  }

  // Per-cylinder misfire counts from the misfire monitor (mode 06, CAN cars). Read-only.
  // Monitor IDs: A1 = all cylinders, A2..AD = cylinder 1..12. Test 0B = average over the
  // last 10 drive cycles, 0C = this (or the last) drive cycle.
  async readMisfires() {
    const mask = parseReply(await this._locked(async () => {
      await this.setHeader(null);
      return this.t.send("06A0", 10000);
    }), "46A0");
    if (!mask || mask.length < 4) return { supported: false, cylinders: [] };
    const bits = ((mask[0] << 24) >>> 0) + (mask[1] << 16) + (mask[2] << 8) + mask[3];
    const out = { supported: true, total: null, cylinders: [] };
    for (let i = 0; i < 32; i++) {
      const mid = 0xA1 + i;
      if (!(bits & (2 ** (31 - i))) || mid > 0xAD) continue;
      const midHex = mid.toString(16).toUpperCase();
      const reply = await this._locked(async () => {
        await this.setHeader(null);
        return this.t.send("06" + midHex, 5000);
      });
      const tests = parseMode06(reply, mid);
      const row = { this_drive: tests[0x0C] ?? null, avg_last_10: tests[0x0B] ?? null };
      if (mid === 0xA1) out.total = row;
      else out.cylinders.push({ cyl: mid - 0xA1, ...row });
    }
    return out;
  }
}

function round3(v) { return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null; }

// "41 0C xx xx 0D xx ..." -> {code: value}. Stops at padding or an unexpected byte.
function parseMulti(reply, sensors) {
  const data = parseReply(reply, "41");
  const out = {};
  let i = 0;
  while (data && i < data.length) {
    const s = sensors[data[i].toString(16).toUpperCase().padStart(2, "0")];
    const n = s ? OBD_PID_LENGTHS[s.code] ?? s.decode.nbytes : 0;
    if (!s || s.code in out || n < s.decode.nbytes || i + 1 + n > data.length) break;
    out[s.code] = round3(s.decode(data.slice(i + 1, i + 1 + n)));
    i += 1 + n;
  }
  return out;
}

const FAILURE_TYPES = {
  0x00: "", 0x01: "general electrical failure", 0x11: "short to ground", 0x12: "short to battery",
  0x13: "open circuit (often a burned-out bulb or broken wire)", 0x14: "short to ground or open",
  0x15: "short to battery or open", 0x16: "voltage too low", 0x17: "voltage too high",
  0x19: "current too high", 0x1A: "resistance too low", 0x1B: "resistance too high",
  0x1E: "out of range", 0x4B: "over temperature", 0x92: "performance or incorrect operation",
  0x96: "component internal failure",
};

// "59 02 <mask> [DTC hi, DTC lo, failure type, status] ..." -> list of codes.
function parseUdsDtcs(reply) {
  const data = parseReply(reply, "5902");
  if (data === null) return null;
  const out = [];
  const hx = (n) => n.toString(16).toUpperCase();
  for (let i = 1; i < data.length - 3; i += 4) {
    const [hi, lo, ftb, st] = data.slice(i, i + 4);
    if (!(hi || lo)) continue;
    out.push({
      code: "PCBU"[hi >> 6] + hx((hi & 0x3F) >> 4) + hx(hi & 0x0F) + hx(lo).padStart(2, "0"),
      type: hx(ftb).padStart(2, "0"), meaning: FAILURE_TYPES[ftb] || "",
      active: !!(st & 0x01), confirmed: !!(st & 0x08),
    });
  }
  return out;
}

// CAN mode 06 reply -> {test id: value}. Records are MID TID UNIT VALUE(2) MIN(2) MAX(2).
function parseMode06(reply, mid) {
  const data = parseReply(reply, "46");
  const tests = {};
  for (let i = 0; data && i + 9 <= data.length; i += 9) {
    if (data[i] === mid) tests[data[i + 1]] = (data[i + 3] << 8) | data[i + 4];
  }
  return tests;
}
