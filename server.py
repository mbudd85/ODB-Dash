"""OBD2 dashboard server.

Bridges the ELM327 adapter (raw TCP) to the browser (WebSocket) and serves
the web app. Run:  python server.py --sim       (no car needed)
                   python server.py             (Veepeak at 192.168.0.10:35000)
"""

import argparse
import asyncio
import csv
import io
import json
import logging
import socket
import time
from datetime import datetime
from pathlib import Path

from aiohttp import web, WSMsgType

from obd import economy
from obd.db import Database
from obd.elm327 import Elm327, TcpTransport
from obd.formula import FormulaError
from obd.pids import ADAPTER_VOLTAGE, Registry, custom_sensor
from obd.simulator import SimTransport

ROOT = Path(__file__).parent
STATIC = ROOT / "static"
CERTS = ROOT / "certs"
OLD_DASHBOARDS = ROOT / "dashboards.json"

log = logging.getLogger("server")


class Bridge:
    """Keeps one adapter connection alive and polls what the browsers want."""

    def __init__(self, mode: str, host: str, port: int, db: Database, registry: Registry):
        self.mode, self.host, self.port = mode, host, port
        self.db = db
        self.registry = registry
        self.record_codes: set[str] = set()
        self.clients: dict[web.WebSocketResponse, set[str]] = {}
        self.status = {"state": "idle", "message": ""}
        self.elm: Elm327 | None = None
        self.task: asyncio.Task | None = None
        self.rate = 0.0
        self.auto_record = False
        self.auto_trip = False          # True while a trip was started by auto-record
        self.gps = None                 # GpsdClient when --gps is on
        self.economy = economy.FuelEconomy()

    def config(self) -> dict:
        return {"mode": self.mode, "host": self.host, "port": self.port,
                "recording": self.db.recording, "auto_record": self.auto_record,
                "gps": self.gps.state if self.gps else None}

    async def on_gps_fix(self, fix: dict):
        self.db.log_location(fix["t"], fix["lat"], fix["lon"], fix["acc"], fix["speed"], fix["heading"])
        await self.broadcast({"type": "gps", **fix})

    def dashboard_codes(self) -> set[str]:
        data = self.db.get_json("dashboards") or {}
        return {w["code"] for d in data.get("dashboards", []) for w in d.get("widgets", [])}

    async def auto_start(self):
        if self.auto_record and not self.db.recording:
            self.record_codes = self.dashboard_codes() or {"0C", "0D", "05", "RV"}
            self.db.start_trip()
            self.economy.reset()
            self.auto_trip = True
            log.info("Auto-record: trip started")

    async def auto_stop(self):
        if self.auto_trip and self.db.recording:
            self.db.stop_trip()
            log.info("Auto-record: trip stopped")
        self.auto_trip = False

    def start(self):
        self.task = asyncio.create_task(self.run())

    async def restart(self, mode, host, port):
        self.mode, self.host, self.port = mode, host, port
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):
                pass
        self.start()

    async def set_status(self, **kw):
        self.status = kw
        await self.broadcast({"type": "status", **kw, "config": self.config()})

    async def broadcast(self, msg: dict):
        data = json.dumps(msg)
        for ws in list(self.clients):
            try:
                await ws.send_str(data)
            except Exception:
                self.clients.pop(ws, None)

    def wanted(self) -> list[str]:
        codes = set().union(*self.clients.values()) if self.clients else set()
        # Keep recording even if the phone locks and its connection drops.
        if self.db.recording:
            codes |= self.record_codes
        return sorted(codes)

    async def run(self):
        while True:
            transport = SimTransport() if self.mode == "sim" else TcpTransport(self.host, self.port)
            self.elm = Elm327(transport, self.registry)
            where = "simulator" if self.mode == "sim" else f"{self.host}:{self.port}"
            try:
                await self.set_status(state="connecting", message=f"Connecting to {where}…")
                await self.elm.connect()
                await self.set_status(
                    state="connected", message=f"Connected to {where}",
                    version=self.elm.version, protocol=self.elm.protocol,
                    supported=["RV"] + sorted(self.elm.supported))
                self.economy.reset()
                await self.auto_start()
                await self.set_status(**self.status)  # re-send so the REC button updates
                await self.poll()
            except asyncio.CancelledError:
                await self.elm.close()
                raise
            except Exception as e:
                log.warning("Adapter error: %r", e)
                await self.elm.close()
                await self.auto_stop()
                await self.set_status(state="error", message=f"{where}: {e or type(e).__name__}. Retrying in 5 s.")
                await asyncio.sleep(5)

    async def poll(self):
        failures = 0
        while True:
            codes = self.wanted()
            if not codes:
                await asyncio.sleep(0.2)
                continue
            calc = [c for c in codes if c in economy.CODES]
            if calc:  # poll what the MPG calculation needs, once each
                codes = sorted((set(codes) - set(economy.CODES)) | set(economy.needed(self.elm.supported, calc)))
            start = time.monotonic()
            values = {}
            for code in codes:
                sensor = self.registry.get(code)
                if code != "RV" and sensor is None:
                    continue
                # Standard PIDs the car says it lacks are skipped; enhanced ones are always tried.
                if sensor and sensor.standard and self.elm.supported and code not in self.elm.supported:
                    continue
                try:
                    values[code] = await self.elm.read(code)
                    failures = 0
                except asyncio.TimeoutError:
                    failures += 1
                    if failures >= 5:
                        raise ConnectionError("adapter stopped responding")
            elapsed = time.monotonic() - start
            self.rate = len(codes) / elapsed if elapsed else 0
            if calc:
                derived = self.economy.update(values)
                derived[economy.HP], derived[economy.TORQUE] = economy.estimate_power(values, self.elm.supported)
                values.update({c: v for c, v in derived.items() if c in calc})
            now = time.time()
            self.db.log(now, values)
            await self.broadcast({"type": "data", "values": values, "t": now,
                                  "rate": round(self.rate, 1)})
            await asyncio.sleep(0.02)


# ---------------------------------------------------------------- HTTP routes

async def ws_handler(request):
    bridge: Bridge = request.app["bridge"]
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    bridge.clients[ws] = set()
    await ws.send_str(json.dumps({"type": "status", **bridge.status, "config": bridge.config()}))
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            data = json.loads(msg.data)
            if data.get("type") == "subscribe":
                bridge.clients[ws] = set(data.get("codes", []))
            elif data.get("type") == "location":
                try:
                    bridge.db.log_location(float(data.get("t") or time.time()), float(data["lat"]),
                                           float(data["lon"]), data.get("acc"), data.get("speed"),
                                           data.get("heading"))
                except (KeyError, TypeError, ValueError):
                    pass
    finally:
        bridge.clients.pop(ws, None)
    return ws


async def get_pids(request):
    return web.json_response(request.app["bridge"].registry.catalog() + economy.CATALOG)


async def get_custom(request):
    return web.json_response(request.app["db"].get_json("custom_sensors") or [])


async def put_custom(request):
    items = await request.json()
    try:
        for d in items:
            custom_sensor(d)  # validate
    except (ValueError, FormulaError) as e:
        raise web.HTTPBadRequest(text=str(e))
    request.app["db"].set_json("custom_sensors", items)
    request.app["bridge"].registry.set_custom(items)
    return web.json_response({"ok": True})


SAFE_AT = {"ATRV", "ATDP", "ATDPN", "ATI", "AT@1"}


async def post_raw(request):
    """Test console. Sends one read-only command; optionally decodes it with a formula."""
    bridge: Bridge = request.app["bridge"]
    if bridge.status.get("state") != "connected":
        raise web.HTTPServiceUnavailable(text="Not connected to the adapter")
    d = await request.json()
    cmd = (d.get("cmd") or "").upper().replace(" ", "")
    try:
        if cmd.startswith("AT"):
            if cmd not in SAFE_AT:
                raise ValueError("only ATRV, ATDP, ATDPN and ATI are allowed here")
            sensor = None
        else:
            sensor = custom_sensor({**d, "code": "custom_test", "cmd": cmd})
        reply = await bridge.elm.raw(cmd, sensor.header if sensor else None)
        value = None
        if sensor and d.get("formula"):
            value = await bridge.elm.read_sensor(sensor)
    except (ValueError, FormulaError) as e:
        raise web.HTTPBadRequest(text=str(e))
    return web.json_response({"reply": reply, "value": value})


async def get_dashboards(request):
    return web.json_response(request.app["db"].get_json("dashboards"))


async def put_dashboards(request):
    request.app["db"].set_json("dashboards", await request.json())
    return web.json_response({"ok": True})


async def get_trips(request):
    db: Database = request.app["db"]
    return web.json_response({"recording": db.trip_id, "trips": db.trips()})


async def set_recording(request):
    bridge: Bridge = request.app["bridge"]
    data = await request.json()
    if data.get("on"):
        bridge.record_codes = set().union(*bridge.clients.values()) if bridge.clients else set()
        bridge.db.start_trip(data.get("name"))
    else:
        bridge.db.stop_trip()
    await bridge.broadcast({"type": "status", **bridge.status, "config": bridge.config()})
    return web.json_response({"recording": bridge.db.trip_id})


async def trip_csv(request):
    """One row per polling cycle, one column per sensor."""
    db: Database = request.app["db"]
    trip_id = int(request.match_info["id"])
    rows = db.trip_readings(trip_id)
    names = {p.code: f"{p.name} ({p.unit})" for p in request.app["bridge"].registry.sensors.values()}
    names["RV"] = f"{ADAPTER_VOLTAGE['name']} ({ADAPTER_VOLTAGE['unit']})"
    codes = sorted({r["code"] for r in rows})
    by_t: dict[float, dict] = {}
    for r in rows:
        by_t.setdefault(r["t"], {})[r["code"]] = r["value"]
    locs = db.trip_locations(trip_id)
    times = [l["t"] for l in locs]
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["time", "latitude", "longitude"] + [names.get(c, c) for c in codes])
    for t, vals in by_t.items():
        stamp = datetime.fromtimestamp(t).isoformat(timespec="milliseconds")
        loc = db.location_at(locs, times, t)
        w.writerow([stamp, loc["lat"] if loc else "", loc["lon"] if loc else ""]
                   + [vals.get(c, "") for c in codes])
    return web.Response(text=buf.getvalue(), content_type="text/csv", headers={
        "Content-Disposition": f'attachment; filename="trip-{trip_id}.csv"'})


async def trip_track(request):
    db: Database = request.app["db"]
    trip_id = int(request.match_info["id"])
    trip = next((t for t in db.trips() if t["id"] == trip_id), None)
    if not trip:
        raise web.HTTPNotFound(text="No such trip")
    return web.json_response({"trip": trip, "points": db.trip_track(trip_id)})


async def delete_trip(request):
    request.app["db"].delete_trip(int(request.match_info["id"]))
    return web.json_response({"ok": True})


async def get_dtcs(request):
    bridge: Bridge = request.app["bridge"]
    if bridge.status.get("state") != "connected":
        raise web.HTTPServiceUnavailable(text="Not connected to the adapter")
    return web.json_response({"codes": await bridge.elm.read_dtcs()})


async def get_config(request):
    return web.json_response(request.app["bridge"].config())


async def post_config(request):
    data = await request.json()
    bridge: Bridge = request.app["bridge"]
    mode = "sim" if data.get("mode") == "sim" else "car"
    await bridge.restart(mode, data.get("host") or bridge.host, int(data.get("port") or bridge.port))
    return web.json_response(bridge.config())


async def ca_cert(request):
    """The iPhone downloads this once and installs it (Settings → Profile Downloaded)."""
    path = CERTS / "ca.crt"
    if not path.exists():
        raise web.HTTPNotFound(text="HTTPS is off. Start the server with --iphone.")
    return web.Response(body=path.read_bytes(), content_type="application/x-x509-ca-cert",
                        headers={"Content-Disposition": 'attachment; filename="obd-dash-ca.crt"'})


async def get_info(request):
    return web.json_response(request.app.get("urls", {}))


async def post_connect(request):
    bridge: Bridge = request.app["bridge"]
    await bridge.restart(bridge.mode, bridge.host, bridge.port)
    return web.json_response(bridge.config())


async def index(request):
    return web.FileResponse(STATIC / "index.html")


@web.middleware
async def no_stale_files(request, handler):
    """Make browsers re-check app files each load, so an update shows up without a hard reload."""
    resp = await handler(request)
    if not request.path.startswith(("/api/", "/ws")):
        resp.headers.setdefault("Cache-Control", "no-cache")
    return resp


def make_app(bridge: Bridge) -> web.Application:
    app = web.Application(middlewares=[no_stale_files])
    app["bridge"] = bridge
    app["db"] = bridge.db
    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/api/pids", get_pids)
    app.router.add_get("/api/dashboards", get_dashboards)
    app.router.add_put("/api/dashboards", put_dashboards)
    app.router.add_get("/api/dtcs", get_dtcs)
    app.router.add_get("/api/config", get_config)
    app.router.add_post("/api/config", post_config)
    app.router.add_post("/api/connect", post_connect)
    app.router.add_get("/api/custom-sensors", get_custom)
    app.router.add_put("/api/custom-sensors", put_custom)
    app.router.add_post("/api/raw", post_raw)
    app.router.add_get("/api/trips", get_trips)
    app.router.add_post("/api/recording", set_recording)
    app.router.add_get("/api/trips/{id}.csv", trip_csv)
    app.router.add_get("/api/trips/{id}/track", trip_track)
    app.router.add_delete("/api/trips/{id}", delete_trip)
    app.router.add_get("/map", lambda r: web.FileResponse(STATIC / "map.html"))
    app.router.add_get("/ca.crt", ca_cert)
    app.router.add_get("/api/info", get_info)
    app.router.add_static("/", STATIC)

    async def on_startup(app):
        bridge.start()
        if bridge.gps:
            app["gps_task"] = asyncio.create_task(bridge.gps.run())
    app.on_startup.append(on_startup)

    async def on_cleanup(app):
        bridge.db.stop_trip()
    app.on_cleanup.append(on_cleanup)
    return app


def main():
    ap = argparse.ArgumentParser(description="OBD2 dashboard server")
    ap.add_argument("--sim", action="store_true", help="use the built-in simulated car")
    ap.add_argument("--obd-host", default="192.168.0.10", help="adapter IP (Veepeak default 192.168.0.10)")
    ap.add_argument("--obd-port", type=int, default=35000, help="adapter TCP port (Veepeak default 35000)")
    ap.add_argument("--listen", default="127.0.0.1",
                    help="address for the web server (default: this device only; 0.0.0.0 = whole network)")
    ap.add_argument("--iphone", action="store_true",
                    help="serve your iPhone: listen on the network and turn on HTTPS (needed for location)")
    ap.add_argument("--https", action="store_true", help="also serve HTTPS on --https-port")
    ap.add_argument("--gps", action="store_true", help="read positions from gpsd (USB GPS on a Raspberry Pi)")
    ap.add_argument("--auto-record", action="store_true",
                    help="record a trip automatically whenever the adapter is connected (car on)")
    ap.add_argument("--db", default=str(ROOT / "obd.db"), help="SQLite database file")
    ap.add_argument("--port", type=int, default=8080, help="web server port (plain HTTP)")
    ap.add_argument("--https-port", type=int, default=8443, help="HTTPS port")
    args = ap.parse_args()
    if args.iphone:
        args.https = True
        if args.listen == "127.0.0.1":
            args.listen = "0.0.0.0"
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s: %(message)s")
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
    db = Database(Path(args.db))
    db.import_dashboards_file(OLD_DASHBOARDS)
    registry = Registry()
    registry.set_custom(db.get_json("custom_sensors") or [])
    for err in registry.errors:
        log.warning("Sensor skipped: %s", err)
    bridge = Bridge("sim" if args.sim else "car", args.obd_host, args.obd_port, db, registry)
    bridge.auto_record = args.auto_record
    if args.gps:
        from obd.gps import GpsdClient
        bridge.gps = GpsdClient(bridge.on_gps_fix)
    app = make_app(bridge)

    ssl_ctx = None
    ips = ["127.0.0.1"]
    if args.https:
        from obd.certs import local_ips, server_context
        ips = local_ips() if args.listen == "0.0.0.0" else [args.listen]
        ssl_ctx = server_context(CERTS, ips)
    app["urls"] = {"https_port": args.https_port if ssl_ctx else None, "http_port": args.port, "ips": ips,
                   "db_path": str(Path(args.db).resolve()), "host": socket.gethostname()}

    async def serve():
        runner = web.AppRunner(app)
        await runner.setup()
        await web.TCPSite(runner, args.listen, args.port).start()
        if ssl_ctx:
            await web.TCPSite(runner, args.listen, args.https_port, ssl_context=ssl_ctx).start()
        print("\nOBD Dash is running. Open:")
        shown = [ip for ip in ips if ip != "192.168.137.1"] if args.listen == "0.0.0.0" else [args.listen]
        for ip in shown:
            host = "localhost" if ip == "127.0.0.1" else ip
            if ssl_ctx:
                print(f"  https://{host}:{args.https_port}   (dashboard with location)")
            print(f"  http://{host}:{args.port}" + ("   (first time on iPhone: open /ca.crt here)" if ssl_ctx else ""))
        print("Press Ctrl+C to stop.\n")
        try:
            await asyncio.Event().wait()
        finally:
            await runner.cleanup()

    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
