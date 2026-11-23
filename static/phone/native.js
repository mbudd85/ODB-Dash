// Android app (Fire tablet) only: the native ObdTcp plugin gives the page a raw TCP
// connection to the WiFi adapter, which a normal web page can't open.
// In a browser this file does nothing and the app falls back to Bluetooth / simulator.
"use strict";

(() => {
  const cap = window.Capacitor;
  if (!cap?.isNativePlatform?.() || !cap.nativePromise) return;
  const call = (method, options = {}) => cap.nativePromise("ObdTcp", method, options);
  let listener = null, handlers = null, streamSeq = 0;   // one "pass" listener for the whole page

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
    // Many commands in one trip to the app; replies[i] is null if command i timed out.
    async sendMany(cmds, timeoutMs = 5000) {
      try {
        return (await call("sendMany", { cmds, timeout: timeoutMs })).replies;
      } catch (e) {
        throw new Error(e?.message || String(e));
      }
    }

    // Stream mode: the app keeps polling `passes` (lists of {h, c}) back to back and calls
    // onPass({i, replies, ms}) for each; onError(message) if the connection drops.
    async startStream(passes, onPass, onError) {
      const id = ++streamSeq;
      listener ||= cap.addListener("ObdTcp", "pass", (ev) => {
        if (!ev.error) call("ack").catch(() => {});
        if (ev.id === streamSeq && handlers) (ev.error ? handlers.onError : handlers.onPass)(ev.error || ev);
      });
      handlers = { onPass, onError };
      await call("startStream", { passes, id, timeout: 2000 });
    }
    async stopStream() {
      streamSeq++;   // ignore anything still on its way
      handlers = null;
      try { await call("stopStream"); } catch {}
    }
  }
  window.OBDNativeTcp = NativeTcpTransport;

  // Saving a CSV: web pages download files, the app writes them to the tablet's Download folder.
  window.OBDSaveFile = async (name, text) => (await call("saveFile", { name, text })).path;
})();
