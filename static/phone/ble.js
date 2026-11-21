// Bluetooth LE transport for ELM327 adapters (Web Bluetooth).
// On iPhone this needs a browser with Web Bluetooth, such as Bluefy; Safari has none.
"use strict";

// Service/characteristic pairs used by common BLE OBD2 adapters.
const BLE_PROFILES = [
  { service: "0000fff0-0000-1000-8000-00805f9b34fb", notify: "0000fff1-0000-1000-8000-00805f9b34fb", write: "0000fff2-0000-1000-8000-00805f9b34fb" },
  { service: "0000ffe0-0000-1000-8000-00805f9b34fb", notify: "0000ffe1-0000-1000-8000-00805f9b34fb", write: "0000ffe1-0000-1000-8000-00805f9b34fb" },
  { service: "000018f0-0000-1000-8000-00805f9b34fb", notify: "00002af0-0000-1000-8000-00805f9b34fb", write: "00002af1-0000-1000-8000-00805f9b34fb" },
  { service: "e7810a71-73ae-499d-8c15-faa9aef0c3f2", notify: "bef8d6c9-9c21-4c9e-b632-bd58c1009f9f", write: "bef8d6c9-9c21-4c9e-b632-bd58c1009f9f" },
];

class BleTransport {
  static get available() { return !!navigator.bluetooth; }

  // Must be called straight from a tap (browsers require a user gesture to pick a device).
  static requestDevice() {
    return navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: BLE_PROFILES.map((p) => p.service),
    });
  }

  constructor(device) {
    this.device = device;
    this.buf = "";
    this.waiter = null;
    this.onDisconnect = null;
  }

  async open() {
    this.device.addEventListener("gattserverdisconnected", () => {
      this.waiter?.reject(new Error("Bluetooth adapter disconnected"));
      this.onDisconnect?.();
    });
    const server = await this.device.gatt.connect();
    for (const p of BLE_PROFILES) {
      let service;
      try { service = await server.getPrimaryService(p.service); } catch { continue; }
      this.rx = await service.getCharacteristic(p.notify);
      this.tx = await service.getCharacteristic(p.write);
      break;
    }
    if (!this.rx) throw new Error("This Bluetooth device doesn't look like an OBD2 adapter");
    this.rx.addEventListener("characteristicvaluechanged", (e) => {
      this.buf += new TextDecoder().decode(e.target.value);
      const i = this.buf.indexOf(">");
      if (i >= 0 && this.waiter) {
        const reply = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        const w = this.waiter;
        this.waiter = null;
        w.resolve(reply);
      }
    });
    await this.rx.startNotifications();
  }

  async close() {
    try { await this.rx?.stopNotifications(); } catch {}
    if (this.device.gatt.connected) this.device.gatt.disconnect();
  }

  async send(cmd, timeoutMs = 5000) {
    this.buf = "";
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = null; reject(Object.assign(new Error("timeout"), { timeout: true })); }, timeoutMs);
      this.waiter = { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } };
    });
    const bytes = new TextEncoder().encode(cmd + "\r");
    for (let i = 0; i < bytes.length; i += 20) {   // BLE packets are small
      const chunk = bytes.slice(i, i + 20);
      if (this.tx.properties.writeWithoutResponse) await this.tx.writeValueWithoutResponse(chunk);
      else await this.tx.writeValue(chunk);
    }
    return reply;
  }
}
