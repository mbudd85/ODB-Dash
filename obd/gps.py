"""GPS for the Raspberry Pi: reads positions from gpsd (localhost:2947).

Plug in a USB GPS receiver (e.g. a u-blox "VK-162" stick), install gpsd, and
start the server with --gps. Positions are saved with recorded trips.
No extra Python packages needed: gpsd speaks JSON lines over TCP.
"""

import asyncio
import json
import logging
import time

log = logging.getLogger("gps")


class GpsdClient:
    def __init__(self, on_fix, host: str = "127.0.0.1", port: int = 2947):
        self.on_fix = on_fix          # called with dict(t, lat, lon, acc, speed, heading)
        self.host, self.port = host, port
        self.last_fix: dict | None = None
        self.state = "starting"

    async def run(self):
        while True:
            try:
                reader, writer = await asyncio.open_connection(self.host, self.port)
                writer.write(b'?WATCH={"enable":true,"json":true};\n')
                await writer.drain()
                self.state = "waiting for fix"
                while line := await asyncio.wait_for(reader.readline(), 30):
                    fix = parse_tpv(line)
                    if fix:
                        self.state = "fix"
                        self.last_fix = fix
                        await self.on_fix(fix)
                raise ConnectionError("gpsd closed the connection")
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.state = f"no GPS ({e or type(e).__name__})"
                log.warning("gpsd: %r, retrying in 5 s", e)
                await asyncio.sleep(5)


def parse_tpv(line: bytes) -> dict | None:
    """gpsd TPV report -> fix dict, or None if it isn't a usable 2D/3D fix."""
    try:
        msg = json.loads(line)
    except ValueError:
        return None
    if msg.get("class") != "TPV" or msg.get("mode", 0) < 2 or "lat" not in msg:
        return None
    acc = None
    if "eph" in msg:
        acc = msg["eph"]
    elif "epx" in msg and "epy" in msg:
        acc = max(msg["epx"], msg["epy"])
    return {"t": time.time(), "lat": msg["lat"], "lon": msg["lon"], "acc": acc,
            "speed": msg.get("speed"), "heading": msg.get("track")}
