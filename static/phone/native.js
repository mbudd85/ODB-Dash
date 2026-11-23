// Android app (Fire tablet) only: the native ObdTcp plugin gives the page a raw TCP
// connection to the WiFi adapter, which a normal web page can't open.
// In a browser this file does nothing and the app falls back to Bluetooth / simulator.
"use strict";

(() => {
  const cap = window.Capacitor;
  if (!cap?.isNativePlatform?.() || !cap.nativePromise) return;
  const call = (method, options = {}) => cap.nativePromise("ObdTcp", method, options);

  class NativeTcpTransport {
    static available = true;
    constructor(host, port) { this.host = host; this.port = port; }
    async open() { await call("open", { host: this.host, port: this.port, timeout: 5000 }); }
    async close() { try { await call("close"); } catch {} }
    async send(cmd, timeoutMs = 5000) {
      try {
        return (await call("send", { cmd, timeout: timeoutMs })).reply;
      } catch (e) {
        // The plugin rejects with code "TIMEOUT" when the ">" prompt doesn't come back in time.
        if (e?.code === "TIMEOUT" || /timeout/i.test(e?.message || "")) throw Object.assign(new Error("timeout"), { timeout: true });
        throw new Error(e?.message || String(e));
      }
    }
  }
  window.OBDNativeTcp = NativeTcpTransport;

  // Saving a CSV: web pages download files, the app writes them to the tablet's Download folder.
  window.OBDSaveFile = async (name, text) => (await call("saveFile", { name, text })).path;
})();
