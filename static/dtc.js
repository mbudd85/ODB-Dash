// Trouble code (DTC) lookup: what a code means, how serious it is, likely causes and what to check.
// Works offline from OBD_DTC_DATA (static/dtc-data.js, built from obd/dtc/ by tools/build_dtcs.py).
(function () {
  const D = typeof OBD_DTC_DATA !== "undefined" ? OBD_DTC_DATA : { generic: {}, makes: { groups: {} }, help: {} };
  const GROUPS = D.makes.groups;

  // Makes offered in the picker, in the order people look for them.
  const MAKES = ["Acura", "BMW", "Chevrolet", "Chrysler", "Dodge", "Ford", "GMC", "Honda", "Hyundai", "Jeep", "Kia",
    "Lexus", "Mazda", "Nissan", "Ram", "Subaru", "Toyota", "Volkswagen",
    "Audi", "Buick", "Cadillac", "Genesis", "Infiniti", "Lincoln", "Mercury", "Mini", "Scion"];

  const groupOf = (make) => {
    if (!make) return null;
    const m = make.toLowerCase();
    for (const [name, g] of Object.entries(GROUPS)) {
      if (name.toLowerCase() === m || g.makes.some((x) => x.toLowerCase() === m)) return name;
    }
    return null;
  };

  const SEV = {
    1: { label: "Low", text: "Safe to drive. Fix when convenient (it may fail an emissions test)." },
    2: { label: "Medium", text: "Fix soon. It can hurt fuel economy or running, or lead to other damage." },
    3: { label: "High", text: "Serious. Avoid hard driving; get it checked right away. If the check-engine light is flashing or a warning says so, stop." },
  };

  const LETTER = { P: "Powertrain (engine and transmission)", B: "Body (lights, airbags, doors, comfort)",
    C: "Chassis (brakes, ABS, steering, suspension)", U: "Network (communication between the car's computers)" };
  const P_AREA = { 0: "fuel and air metering, emissions", 1: "fuel and air metering", 2: "fuel injectors and fuel/air metering",
    3: "ignition system or misfire", 4: "emission controls (EGR, catalyst, EVAP, secondary air)", 5: "vehicle speed, idle control and auxiliary inputs",
    6: "computer and output circuits", 7: "transmission", 8: "transmission", 9: "transmission", A: "hybrid / electric propulsion",
    B: "hybrid / electric propulsion", C: "hybrid / electric propulsion" };

  function normalize(code) {
    const c = String(code || "").trim().toUpperCase().replace(/[^0-9A-Z]/g, "");
    // Body module codes come as e.g. B1234-13; keep the 5-character code.
    return /^[PBCU][0-3][0-9A-F]{3}/.test(c) ? c.slice(0, 5) : null;
  }

  // Generic (same meaning on every car) or manufacturer-specific, per SAE J2012.
  function isGeneric(code) {
    const [l, d] = code;
    if (d === "0") return true;
    if (l === "P" && d === "2") return true;
    if (l === "P" && d === "3") return /^P3[4-9]/.test(code);
    return false;
  }

  function structure(code) {
    const parts = [LETTER[code[0]]];
    parts.push(isGeneric(code) ? "generic code (same meaning on every make)" : "manufacturer-specific code (meaning depends on the make)");
    if (code[0] === "P") parts.push("area: " + (P_AREA[code[2]] || "other"));
    return parts.join(" · ");
  }

  // Help entries keyed by a code or a range "P0301-P0312"; an exact code wins, then the narrowest range.
  const HELP = Object.entries(D.help).map(([key, h]) => {
    const [a, b] = key.split("-");
    return { key, a, b: b || a, h };
  });
  function findHelp(code, title, group) {
    let best = null;
    for (const e of HELP) {
      if (code[0] !== e.a[0] || code < e.a || code > e.b) continue;
      if (e.h.match && !(title || "").includes(e.h.match)) continue;
      if (e.h.only && !(group && e.h.only.includes(group))) continue;
      const width = e.a === e.b ? 0 : parseInt(e.b.slice(1), 16) - parseInt(e.a.slice(1), 16) + 1;
      if (!best || width < best.width) best = { ...e, width };
    }
    if (!best) return null;
    const h = { ...best.h };
    if (h.same && D.help[h.same]) {
      const base = D.help[h.same];
      h.causes ||= base.causes;
      h.checks ||= base.checks;
      h.notes = { ...(base.notes || {}), ...(h.notes || {}) };
    }
    return h;
  }

  // When there's no written help: general advice from the wording of the code's title.
  function ruleHelp(code, title) {
    const t = title || "";
    const causes = [], checks = [];
    let sev = 2;
    if (/Circuit Low|Low Voltage|Low Input/i.test(t)) {
      causes.push("Wire shorted to ground or chafed through", "Failed sensor or component", "Corroded or loose connector");
      checks.push("Inspect the wiring and connector for damage, corrosion or water", "Check the component's supply voltage and ground with a meter");
    } else if (/Circuit High|High Voltage|High Input/i.test(t)) {
      causes.push("Open circuit (broken wire, unplugged connector) or a wire shorted to voltage", "Failed sensor or component", "Bad ground");
      checks.push("Make sure the connector is fully plugged in and its pins aren't pushed back", "Check the ground and signal wires for continuity");
    } else if (/Intermittent|Erratic/i.test(t)) {
      causes.push("Loose connector or a wire that breaks contact when it moves", "Sensor starting to fail");
      checks.push("Watch the sensor in live data while wiggling its wiring and connector");
    } else if (/Range\/Performance|Performance|Stuck|Correlation/i.test(t)) {
      causes.push("Sensor reading drifted or implausible compared with other sensors", "A real mechanical problem in the system it watches", "High resistance in the wiring");
      checks.push("Compare the sensor's live reading with related sensors (it should make physical sense)", "Check for other codes that point to the underlying system");
    } else if (/Circuit|Open/i.test(t)) {
      causes.push("Open or shorted wiring", "Unplugged or corroded connector", "Failed component");
      checks.push("Inspect the connector and wiring", "Measure the component's resistance against the service manual value");
    }
    if (/Solenoid|Valve|Relay|Actuator|Motor|Pump|Heater|Fan|Lamp|Clutch/i.test(t)) {
      checks.push("If you have a scan tool that can command it, switch the part on and off and listen or feel for it working", "Check the fuse that feeds it");
    }
    if (/Sensor/i.test(t)) checks.push("Watch the sensor in the app's live data (add it to a dashboard) to see what it reports");
    if (/EVAP|Catalyst|EGR|Secondary Air|O2 Sensor|HO2S|Heater/i.test(t)) sev = 1;
    if (/Misfire|Over Temperature|Overheat|Oil Pressure|Overboost|Forced/i.test(t)) sev = 3;
    if (code[0] === "U") {
      causes.push("Low battery voltage or a module that lost power or ground", "Network wiring or connector fault");
      checks.push("Check battery voltage and the module's fuses");
    }
    if (code[0] === "P" && /[789]/.test(code[2])) {
      causes.push("Low, old or burnt transmission fluid");
      checks.unshift("Check the transmission fluid level and condition (dark or burnt-smelling fluid is a bad sign)");
    }
    if (!causes.length) causes.push("The component or circuit named in the title, its wiring, or its connector");
    checks.push("Check for service bulletins (TSBs) and recalls for your vehicle", "Clear the code and see whether it comes back before replacing parts");
    return { sev, causes, checks, auto: true };
  }

  function makerMeanings(code) {
    const out = [];
    for (const [name, g] of Object.entries(GROUPS)) if (g.codes[code]) out.push({ group: name, title: g.codes[code] });
    return out;
  }

  function lookup(rawCode, make) {
    const code = normalize(rawCode);
    if (!code) return null;
    const group = groupOf(make);
    const generic = isGeneric(code);
    const meanings = makerMeanings(code);
    let title = null, source = null;
    if (group && GROUPS[group].codes[code]) { title = GROUPS[group].codes[code]; source = group; }
    else if (D.generic[code]) { title = D.generic[code]; source = "generic"; }
    else if (!group && meanings.length === 1) { title = meanings[0].title; source = meanings[0].group; }
    const help = findHelp(code, title, group || (source !== "generic" ? source : null));
    const base = help || ruleHelp(code, title);
    const notes = [];
    for (const [g, text] of Object.entries((help && help.notes) || {})) {
      if (!group || g === group) notes.push({ group: g, text });
    }
    return {
      code, title, source, group, generic, structure: structure(code),
      others: meanings.filter((m) => m.group !== source),
      sev: base.sev, sevLabel: SEV[base.sev].label, sevText: SEV[base.sev].text,
      what: help ? help.what : null, causes: base.causes || [], checks: base.checks || [], notes,
      general: !help,
    };
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const list = (items) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;

  // One code as an expandable block. extra: text shown after the code (e.g. "-13 happening now").
  function render(rawCode, make, { open = false, extra = "" } = {}) {
    const r = lookup(rawCode, make);
    if (!r) return `<div class="dtcitem"><code>${esc(rawCode)}</code> not a valid trouble code</div>`;
    const title = r.title || (r.generic ? "Not in the built-in list" : "Manufacturer-specific code" + (r.group ? ` not in the built-in ${r.group} list` : ""));
    const parts = [];
    if (r.what) parts.push(`<p>${esc(r.what)}</p>`);
    if (!r.title && r.others.length === 0 && !r.generic)
      parts.push(`<p class="muted small">${r.group ? "" : "Pick your make below to see its meaning. "}The meaning depends on the make and model; look it up in a factory service manual or a make-specific tool (e.g. FORScan for Ford/Mazda).</p>`);
    if (r.others.length) {
      const lead = r.group ? "Other makes use this code for:" : "This code means different things on different makes:";
      parts.push(`<p class="small">${lead}</p><ul class="small">${r.others.map((o) => `<li><b>${esc(o.group)}</b>: ${esc(o.title)}</li>`).join("")}</ul>`);
    }
    parts.push(`<p class="small"><span class="sev sev${r.sev}">${r.sevLabel}</span> ${esc(r.sevText)}</p>`);
    parts.push(`<p class="small"><b>${r.general ? "Possible causes (general)" : "Common causes"}</b></p>${list(r.causes)}`);
    parts.push(`<p class="small"><b>What to check</b></p>${list(r.checks)}`);
    for (const n of r.notes) parts.push(`<p class="small note"><b>${esc(n.group)}:</b> ${esc(n.text)}</p>`);
    parts.push(`<p class="muted small">${esc(r.structure)}${r.source && r.source !== "generic" ? ` · meaning from the ${esc(r.source)} list, which can vary by model and year` : ""}</p>`);
    return `<details class="dtcitem"${open ? " open" : ""}><summary><code>${esc(r.code)}${esc(extra)}</code> <span class="sev sev${r.sev}" title="${esc(r.sevText)}">${r.sevLabel}</span> ${esc(title)}</summary>${parts.join("")}</details>`;
  }

  window.OBDDtc = { lookup, render, normalize, groupOf, MAKES, about: D.about || "",
    count: { generic: Object.keys(D.generic).length, maker: Object.values(GROUPS).reduce((n, g) => n + Object.keys(g.codes).length, 0) } };
})();
