// Home screen: a big live RPM gauge with a 3x3 grid of shortcuts beside it.
// Shown when the app opens; "Dashboards" switches to the gauge tabs, Back returns here.
"use strict";

(() => {
  const ICONS = {
    dash: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
    codes: '<path d="M12 3 2.5 20h19L12 3z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.3" r=".6" fill="currentColor"/>',
    map: '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
    rec: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.2" fill="currentColor"/>',
    misfire: '<path d="M13.5 2.5 5 13.5h6l-1.5 8 8.5-11h-6l1.5-8z"/>',
    lamp: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/>',
    car: '<path d="M4 16v-3.5L6 8h12l2 4.5V16"/><path d="M3 16h18v2.5H3z"/><circle cx="7.5" cy="18.5" r="1.6"/><circle cx="16.5" cy="18.5" r="1.6"/>',
    adapter: '<path d="M2.5 9.5a14 14 0 0 1 19 0"/><path d="M5.5 12.8a9.5 9.5 0 0 1 13 0"/><path d="M8.7 16a5 5 0 0 1 6.6 0"/><circle cx="12" cy="19" r="1" fill="currentColor"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  };
  const BUTTONS = [
    ["dash", "Dashboards", () => showDashboards()],
    ["codes", "Fault codes", () => window.openFaultCodes()],
    ["map", "Trips map", () => { location.href = "map.html"; }],
    ["rec", "Record", () => $("#recBtn").click()],
    ["misfire", "Misfires", () => openMenuAt("misfireSection", "#misfireBtn")],
    ["lamp", "Lamp check", () => openMenuAt("codesSection", "#bodyDtcBtn")],
    ["car", "Vehicle", () => openMenuAt("vehicleSection")],
    ["adapter", "Adapter", () => openMenuAt("sourceSection")],
    ["settings", "Settings", () => openMenuAt()],
  ];

  const home = $("#home");
  const grid = home.querySelector(".homegrid");
  for (const [icon, label, go] of BUTTONS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "homebtn";
    b.dataset.icon = icon;
    b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[icon]}</svg><span>${label}</span>`;
    b.onclick = go;
    grid.append(b);
  }

  // Open the settings menu scrolled to one section, optionally pressing a button there.
  function openMenuAt(sectionId, clickSel) {
    $("#menuBtn").click();
    if (!sectionId) return;
    requestAnimationFrame(() => {
      document.getElementById(sectionId)?.scrollIntoView({ block: "start" });
      if (clickSel) $(clickSel).click();
    });
  }
  // The Fault codes button. A fuller fault-code screen can replace this function.
  window.openFaultCodes ||= () => openMenuAt("codesSection", "#dtcBtn");

  // ------------------------------------------------------------ RPM gauge (SVG)

  const MAX = 8, RED = 6;                       // x1000 rpm
  const A0 = -225, A1 = 45;                     // sweep, degrees (0 = pointing right)
  const ang = (v) => A0 + (A1 - A0) * Math.min(1, Math.max(0, v / MAX));
  const pt = (deg, r) => [200 + r * Math.cos(deg * Math.PI / 180), 200 + r * Math.sin(deg * Math.PI / 180)];
  const arc = (v0, v1, r) => {
    const [x0, y0] = pt(ang(v0), r), [x1, y1] = pt(ang(v1), r);
    return `M${x0.toFixed(1)} ${y0.toFixed(1)}A${r} ${r} 0 ${ang(v1) - ang(v0) > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  };
  let ticks = "";
  for (let i = 0; i <= MAX * 4; i++) {
    const v = i / 4, major = i % 4 === 0, half = i % 2 === 0;
    const [x0, y0] = pt(ang(v), 172), [x1, y1] = pt(ang(v), major ? 146 : half ? 156 : 162);
    ticks += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" class="${v >= RED ? "tick red" : "tick"}${major ? " major" : ""}"/>`;
    if (major) {
      const [tx, ty] = pt(ang(v), 124);
      ticks += `<text x="${tx.toFixed(1)}" y="${(ty + 9).toFixed(1)}" class="num${v >= RED ? " red" : ""}">${v}</text>`;
    }
  }
  home.querySelector(".rpm").innerHTML = `
    <svg viewBox="0 0 400 400" role="img" aria-label="Engine RPM">
      <circle cx="200" cy="200" r="194" class="bezel"/>
      <circle cx="200" cy="200" r="184" class="face"/>
      <path d="${arc(0, MAX, 178)}" class="track"/>
      <path d="${arc(RED, MAX, 178)}" class="redzone"/>
      <path d="${arc(0, 0.001, 178)}" class="sweep" id="rpmSweep"/>
      ${ticks}
      <text x="200" y="150" class="label">x1000</text>
      <text x="200" y="284" class="readout" id="rpmValue">–</text>
      <text x="200" y="310" class="unit">rpm</text>
      <g id="rpmNeedle"><path d="M196 206 L200 52 L204 206 Z" class="needle"/></g>
      <circle cx="200" cy="200" r="15" class="hub"/>
    </svg>`;
  const needle = $("#rpmNeedle"), sweep = $("#rpmSweep"), value = $("#rpmValue");
  let shown = 0, lastText = "";

  // Every screen frame: ease the needle toward the latest reading (smooth between readings).
  (function frame() {
    if (!home.hidden) {
      const rpm = state.latest["0C"];
      const target = rpm == null ? 0 : rpm / 1000;
      shown += (target - shown) * 0.35;
      if (Math.abs(target - shown) < 0.002) shown = target;
      needle.setAttribute("transform", `rotate(${(ang(shown) + 90).toFixed(2)} 200 200)`);
      sweep.setAttribute("d", arc(0, Math.max(0.001, shown), 178));
      sweep.classList.toggle("hot", shown >= RED);
      const text = rpm == null ? "–" : Math.round(rpm).toLocaleString();
      if (text !== lastText) { value.textContent = text; lastText = text; }
      const sp = state.latest["0D"], info = state.pids["0D"];
      if (info) {
        const u = unitFor(info);
        $("#homeSpeed").textContent = sp == null ? "–" : Math.round(u.f(sp));
        $("#homeSpeedUnit").textContent = u.unit;
      }
      const st = state.status || {};
      $("#homeStatus").className = "homestatus " + (st.state || "");
      $("#homeStatusText").textContent = st.state === "connected" ? (st.config?.mode === "sim" ? "Simulator" : "Connected")
        : st.state === "connecting" ? "Connecting…" : st.state === "error" ? "No adapter" : "…";
      grid.querySelector('[data-icon="rec"]').classList.toggle("on", !!state.recording);
      grid.querySelector('[data-icon="rec"] span').textContent = state.recording ? "Stop recording" : "Record";
      grid.querySelector('[data-icon="adapter"]').dataset.state = st.state || "";
    }
    requestAnimationFrame(frame);
  })();

  // ------------------------------------------------------------ home <-> dashboards

  function show(homeVisible) {
    home.hidden = !homeVisible;
    document.body.classList.toggle("home", homeVisible);
    if (!homeVisible && state.dashboards.length) renderGrid();
    subscribe();
  }
  function showDashboards() {
    history.pushState({ dash: true }, "", "#dash");
    show(false);
  }
  window.goHome = () => {
    if (history.state?.dash) history.back();   // so Back from the dashboards keeps working
    else { history.replaceState(null, "", location.pathname + location.search); show(true); }
  };
  addEventListener("popstate", () => show(location.hash !== "#dash"));
  $("#homeBtn").onclick = () => window.goHome();
  home.addEventListener("click", (e) => { if (e.target.closest("#homeStatus")) openMenuAt("sourceSection"); });
  show(location.hash !== "#dash");
})();
