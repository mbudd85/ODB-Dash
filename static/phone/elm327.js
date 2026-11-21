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
    await this.detectSupported();
    this.protocol = cleanReply(await this.t.send("ATDP"));
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
      const data = await this._locked(async () => {
        await this.setHeader(null);
        return parseReply(await this.t.send("01" + pid, 15000), "41" + pid);
      });
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
    const reply = await this._locked(async () => {
      await this.setHeader(s.header);
      return this.t.send(s.cmd);
    });
    const data = parseReply(reply, s.replyPrefix);
    if (!data || data.length < s.decode.nbytes) return null;
    const v = s.decode(data);
    return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
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
}
