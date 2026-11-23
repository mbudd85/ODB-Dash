// Fake ELM327 adapter (port of obd/simulator.py): a 60-second driving loop
// plus a pretend Ford that answers a few mode 22 sensors.
"use strict";

const SIM_PIDS = ["04", "05", "06", "07", "0B", "0C", "0D", "0E", "0F", "10", "11",
  "14", "15", "16", "17", "1D", "1F", "21", "2F", "31", "33", "42", "43", "44", "45", "46", "49", "4C", "5C", "5E"];

class SimulatedCar {
  constructor() {
    this.t0 = this.last = performance.now() / 1000;
    Object.assign(this, { speed: 0, rpm: 800, throttle: 0, coolant: 20, oil: 18, fuel: 63, distance: 1234, runtime: 0 });
  }
  step() {
    const now = performance.now() / 1000;
    const dt = now - this.last;
    this.last = now;
    const t = now - this.t0;
    const phase = t % 60;
    let target;
    if (phase < 10) [target, this.throttle] = [50, 35];
    else if (phase < 25) [target, this.throttle] = [60, 18];
    else if (phase < 35) [target, this.throttle] = [110, 80];
    else [target, this.throttle] = [0, 0];
    this.throttle = Math.max(0, Math.min(100, this.throttle + (Math.random() * 4 - 2)));
    this.speed += (target - this.speed) * Math.min(1, dt * 0.35);
    const ratio = [0, 110, 65, 45, 35, 28, 24][Math.min(6, 1 + Math.floor(this.speed / 22))];
    this.rpm = Math.max(780, this.speed * ratio) + (Math.random() * 50 - 25);
    this.coolant += (90 - this.coolant) * Math.min(1, dt * 0.02);
    this.oil += (100 - this.oil) * Math.min(1, dt * 0.012);
    this.fuel = Math.max(0, this.fuel - dt * 0.002);
    this.distance += this.speed * dt / 3600;
    this.runtime = t;
  }
  values() {
    this.step();
    const u8 = (x) => [Math.max(0, Math.min(255, Math.round(x)))];
    const u16 = (x) => { const v = Math.max(0, Math.min(65535, Math.round(x))); return [v >> 8, v & 255]; };
    const load = Math.min(100, 18 + this.throttle * 0.75);
    const maf = this.rpm * load / 2200;
    const r = () => Math.random() * 2 - 1;
    return {
      "04": u8(load * 2.55), "05": u8(this.coolant + 40), "06": u8((r() * 4 + 100) * 1.28),
      "07": u8(102.3 * 1.28), "0B": u8(30 + load * 0.7), "0C": u16(this.rpm * 4), "0D": u8(this.speed),
      "0E": u8((12 + r() * 3 + 64) * 2), "0F": u8(68), "10": u16(maf * 100),
      "11": u8((14 + this.throttle * 0.8) * 2.55),
      // O2 sensors like a V8 with 4: upstream ones switch, downstream ones stay steady
      "14": [...u8((Math.random() < 0.5 ? 0.15 : 0.8) * 200 + r() * 10), 128], "15": [...u8(130 + r() * 6), 255],
      "16": [...u8((Math.random() < 0.5 ? 0.15 : 0.8) * 200 + r() * 10), 128], "17": [...u8(124 + r() * 6), 255],
      "1D": [0x0F],   // bank 1 sensors 1-2, bank 2 sensors 1-2 "1F": u16(this.runtime), "21": u16(0),
      "2F": u8(this.fuel * 2.55), "31": u16(this.distance), "33": [101],
      "42": u16((14.1 + 0.15 * Math.sin(this.runtime)) * 1000), "43": u16(load * 2.55), "44": u16(32768),
      "45": u8(this.throttle * 2.55), "46": u8(58), "49": u8((15 + this.throttle * 0.8) * 2.55),
      "4C": u8(this.throttle * 2.55), "5C": u8(this.oil + 40), "5E": u16((0.8 + maf * 0.09) * 20),
    };
  }
}

function simSupportMask(base) {
  let mask = 0;
  for (const code of [...SIM_PIDS, "20", "40"]) {
    const n = parseInt(code, 16);
    if (base < n && n <= base + 32) mask += 2 ** (31 - (n - base - 1));
  }
  return mask.toString(16).toUpperCase().padStart(8, "0");
}

class SimTransport {
  constructor(latency = 30) { this.car = new SimulatedCar(); this.latency = latency; this.header = "7DF"; }
  async open() { await new Promise((r) => setTimeout(r, 200)); }
  async close() {}
  async send(cmd) {
    await new Promise((r) => setTimeout(r, this.latency));
    return this.answer(cmd.trim().toUpperCase().replace(/ /g, ""));
  }
  answer(cmd) {
    const hex = (bytes) => bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join("");
    if (cmd === "ATZ") return "\r\rELM327 v1.5 (simulator)\r\r";
    if (cmd === "ATRV") return `${(13.9 + Math.random() * 0.3).toFixed(1)}V\r\r`;
    if (cmd.startsWith("ATSH")) { this.header = cmd.slice(4); return "OK\r\r"; }
    if (cmd === "ATDPN") return "A6\r\r";
    if (cmd === "ATDP") return "AUTO, ISO 15765-4 (CAN 11/500)\r\r";
    if (cmd.startsWith("AT")) return "OK\r\r";
    if (["01", "22"].includes(cmd.slice(0, 2)) && cmd.length % 2) cmd = cmd.slice(0, -1);   // "number of replies" digit
    if (cmd.startsWith("01") && cmd.length > 4) {   // several PIDs at once
      const vals = this.car.values();
      const parts = [];
      for (let i = 2; i < cmd.length; i += 2) { const p = cmd.slice(i, i + 2); if (vals[p]) parts.push(p + hex(vals[p])); }
      return parts.length ? `41${parts.join("")}\r\r` : "NO DATA\r\r";
    }
    if (cmd === "19020D") return this.header === "726" ? "5902FF90E31309\r\r" : "NO DATA\r\r";   // body module: a lamp out
    if (cmd === "06A0") return "46A0F8000000\r\r";   // misfire monitor: all + cylinders 1-4
    if (/^06A[1-5]$/.test(cmd)) {
      const mid = parseInt(cmd.slice(2), 16), cyl = mid - 0xA1;
      const [now, avg] = { 0: [5, 2], 3: [4, 2] }[cyl] || [0, 0];   // cylinder 3 misfires a little
      const h4 = (v) => v.toString(16).toUpperCase().padStart(4, "0");
      return "46" + [[0x0B, avg], [0x0C, now]].map(([tid, v]) => `${hex([mid, tid])}24${h4(v)}0000FFFF`).join("") + "\r\r";
    }
    if (cmd.startsWith("22")) {
      const c = this.car; c.step();
      const tft = Math.round((40 + Math.min(50, c.runtime / 6)) * 16);
      const odo = Math.floor(c.distance);
      const table = {
        "7E1:1E1C": [tft >> 8, tft & 255],
        "7E1:1E12": [c.speed < 2 ? 0 : Math.min(6, 1 + Math.floor(c.speed / 22))],
        "7E0:054B": [72], "7E0:DD01": [odo >> 16, (odo >> 8) & 255, odo & 255], "726:4028": [86],
      };
      const data = table[`${this.header}:${cmd.slice(2)}`];
      if (!data) return ["7E0", "7E1", "726"].includes(this.header) ? "7F2231\r\r" : "NO DATA\r\r";
      return "62" + cmd.slice(2) + hex(data) + "\r\r";
    }
    if (cmd === "03") return "43010133\r\r";
    if (cmd.startsWith("01") && cmd.length === 4) {
      const pid = cmd.slice(2), n = parseInt(pid, 16);
      if (n % 0x20 === 0 && n <= 0x40) return `41${pid}${simSupportMask(n)}\r\r`;
      const v = this.car.values()[pid];
      return v ? `41${pid}${hex(v)}\r\r` : "NO DATA\r\r";
    }
    return "?\r\r";
  }
}
