// Calculated sensors: instant/average MPG, estimated horsepower/torque, boost. Port of obd/economy.py.
// MPG comes from speed (0D) and fuel flow: the car's fuel rate (5E) if it has one, else
// mass air flow (10) assuming gasoline at 14.7:1.
"use strict";

const Economy = (() => {
  const INSTANT = "CALC_MPG", AVERAGE = "CALC_AVG_MPG", HP = "CALC_HP", TORQUE = "CALC_TORQUE", BOOST = "CALC_BOOST";
  const CODES = [INSTANT, AVERAGE, HP, TORQUE, BOOST];
  const AFR = 14.7, DENSITY = 737.0, L_PER_GAL = 3.785411784, KM_PER_MILE = 1.609344, MAX_MPG = 150;
  const BSFC = 0.5, NM_PER_LBFT = 1.35582;
  const CATALOG = [
 {
  "code": "CALC_MPG",
  "name": "Instant fuel economy",
  "unit": "mpg",
  "min": 0,
  "max": 60,
  "category": "Fuel economy",
  "make": "Calculated",
  "verified": true,
  "cmd": "",
  "header": null,
  "formula": "",
  "nbytes": 0,
  "note": "Worked out from speed and fuel flow (fuel rate, or MAF assuming gasoline). 0 when stopped."
 },
 {
  "code": "CALC_AVG_MPG",
  "name": "Average fuel economy (this drive)",
  "unit": "mpg",
  "min": 0,
  "max": 60,
  "category": "Fuel economy",
  "make": "Calculated",
  "verified": true,
  "cmd": "",
  "header": null,
  "formula": "",
  "nbytes": 0,
  "note": "Distance ÷ fuel since the car was switched on (or the adapter reconnected)."
 },
 {
  "code": "CALC_HP",
  "name": "Engine power (estimate)",
  "unit": "hp",
  "min": 0,
  "max": 400,
  "category": "Performance",
  "make": "Calculated",
  "verified": false,
  "cmd": "",
  "header": null,
  "formula": "",
  "nbytes": 0,
  "note": "Estimate. Uses the car's actual-torque data (PIDs 62+63) if it has them; otherwise air flow (MAF, gasoline): roughly ±20%. Engine (crank) power, not power at the wheels."
 },
 {
  "code": "CALC_TORQUE",
  "name": "Engine torque (estimate)",
  "unit": "lb-ft",
  "min": 0,
  "max": 400,
  "category": "Performance",
  "make": "Calculated",
  "verified": false,
  "cmd": "",
  "header": null,
  "formula": "",
  "nbytes": 0,
  "note": "Estimate, same source as engine power. Torque = power ÷ RPM."
 },
 {
  "code": "CALC_BOOST",
  "name": "Boost / vacuum",
  "unit": "kPa",
  "min": -100,
  "max": 150,
  "category": "Performance",
  "make": "Calculated",
  "verified": true,
  "cmd": "",
  "header": null,
  "formula": "",
  "nbytes": 0,
  "note": "Intake manifold pressure minus outside air pressure. Above 0 = boost (turbo, e.g. EcoBoost), below 0 = vacuum. Shown in psi with imperial units."
 }
];

  const boost = (v) => (v["0B"] == null ? null : Math.round((v["0B"] - (v["33"] || 101.3)) * 10) / 10);

  function estimatePower(v) {
    const rpm = v["0C"];
    if (rpm == null) return [null, null];
    let hp, nm;
    if (v["62"] != null && v["63"]) {
      nm = Math.max(0, v["62"] / 100 * v["63"]);
      hp = nm * rpm / 9549 * 1.34102;
    } else if (v["10"] != null) {
      hp = (v["10"] * 3600 / AFR / 453.592) / BSFC;
      nm = rpm > 300 ? hp / 1.34102 * 9549 / rpm : 0;
    } else return [null, null];
    return [Math.round(hp), Math.round(nm / NM_PER_LBFT)];
  }

  function fuelLph(v) {
    if (v["5E"] != null) return v["5E"];
    if (v["10"] != null) return v["10"] * 3600 / (AFR * DENSITY);
    return null;
  }

  // PIDs to poll for the requested calculated sensors.
  function needed(supported, calc = CODES) {
    const has = (c) => !supported.size || supported.has(c);
    const out = new Set();
    if (calc.includes(INSTANT) || calc.includes(AVERAGE)) { out.add("0D"); out.add(has("5E") || !has("10") ? "5E" : "10"); }
    if (calc.includes(HP) || calc.includes(TORQUE)) {
      out.add("0C");
      if (has("62") && has("63") && supported.size) { out.add("62"); out.add("63"); } else out.add("10");
    }
    if (calc.includes(BOOST)) { out.add("0B"); if (has("33")) out.add("33"); }
    return [...out].sort();
  }

  class FuelEconomy {
    constructor() { this.reset(); }
    reset() { this.km = 0; this.litres = 0; this.lastT = null; }
    update(v, t = performance.now() / 1000) {
      const speed = v["0D"], lph = fuelLph(v);
      const out = { [INSTANT]: null, [AVERAGE]: null };
      if (speed == null || lph == null) { this.lastT = t; return out; }
      if (this.lastT != null && t - this.lastT > 0 && t - this.lastT < 10) {
        const dtH = (t - this.lastT) / 3600;
        this.km += speed * dtH;
        this.litres += lph * dtH;
      }
      this.lastT = t;
      if (speed < 1) out[INSTANT] = 0;
      else if (lph <= 0.01) out[INSTANT] = MAX_MPG;
      else out[INSTANT] = Math.round(Math.min(MAX_MPG, (speed / KM_PER_MILE) / (lph / L_PER_GAL)) * 10) / 10;
      if (this.litres > 0.001) out[AVERAGE] = Math.round(Math.min(MAX_MPG, (this.km / KM_PER_MILE) / (this.litres / L_PER_GAL)) * 10) / 10;
      return out;
    }
  }

  return { INSTANT, AVERAGE, HP, TORQUE, BOOST, CODES, CATALOG, boost, estimatePower, needed, FuelEconomy };
})();
