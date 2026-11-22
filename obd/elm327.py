"""Talk to an ELM327-compatible adapter (e.g. Veepeak Mini WiFi) over TCP.

The adapter speaks plain text: we send a command ending in "\r" and it replies
with text ending in the ">" prompt.
"""

import asyncio
import logging
import re

from .pids import Registry, Sensor

log = logging.getLogger("elm327")

INIT_COMMANDS = [
    "ATZ",    # reset
    "ATE0",   # echo off
    "ATL0",   # linefeeds off
    "ATS0",   # spaces off
    "ATH0",   # headers off
    "ATSP0",  # automatic protocol detection
]

NO_DATA = ("NO DATA", "UNABLE TO CONNECT", "CAN ERROR", "BUS ERROR", "STOPPED", "ERROR", "?")


class TcpTransport:
    """Raw ELM327 link over TCP (WiFi adapters)."""

    def __init__(self, host: str, port: int, timeout: float = 5.0):
        self.host, self.port, self.timeout = host, port, timeout
        self.reader = self.writer = None
        self.lock = asyncio.Lock()

    async def open(self):
        self.reader, self.writer = await asyncio.wait_for(
            asyncio.open_connection(self.host, self.port), self.timeout)

    async def close(self):
        if self.writer:
            self.writer.close()
            try:
                await self.writer.wait_closed()
            except Exception:
                pass
        self.reader = self.writer = None

    async def send(self, cmd: str, timeout: float | None = None) -> str:
        async with self.lock:
            self.writer.write((cmd + "\r").encode("ascii"))
            await self.writer.drain()
            raw = await asyncio.wait_for(self.reader.readuntil(b">"), timeout or self.timeout)
            return raw.decode("ascii", "ignore").rstrip(">")


class Elm327:
    """OBD-II reader on top of any transport that has async open/close/send."""

    def __init__(self, transport, registry: Registry | None = None):
        self.t = transport
        self.registry = registry or Registry()
        self.header: str | None = None   # None = default broadcast (7DF on CAN)
        # Header change + request must not interleave with another caller's.
        self.io = asyncio.Lock()
        self.supported: set[str] = set()
        self.version = ""
        self.protocol = ""

    async def connect(self):
        await self.t.open()
        for cmd in INIT_COMMANDS:
            reply = await self.t.send(cmd, timeout=10)
            if cmd == "ATZ":
                self.version = _clean(reply)
        # First real query makes the adapter search for the car's protocol;
        # that can take several seconds.
        await self.detect_supported()
        self.protocol = _clean(await self.t.send("ATDP"))

    async def close(self):
        await self.t.close()

    async def detect_supported(self):
        self.supported = set()
        base = 0x00
        while True:
            data = await self.query_raw(f"{base:02X}", timeout=15)
            if not data or len(data) < 4:
                break
            mask = int.from_bytes(bytes(data[:4]), "big")
            for i in range(32):
                if mask & (1 << (31 - i)):
                    self.supported.add(f"{base + i + 1:02X}")
            nxt = base + 0x20
            if f"{nxt:02X}" not in self.supported or nxt > 0xC0:
                break
            base = nxt
        log.info("Supported PIDs: %s", sorted(self.supported))

    async def set_header(self, header: str | None):
        """Pick which module answers: e.g. 7E1 = transmission. None = all (broadcast)."""
        if header == self.header:
            return
        reply = await self.t.send("ATSH" + (header or "7DF"))
        if "?" in reply:
            raise ValueError(f"adapter rejected header {header}")
        self.header = header

    async def query_raw(self, pid: str, timeout: float | None = None) -> list[int] | None:
        """Send mode 01 request, return the data bytes after '41 <pid>'."""
        async with self.io:
            await self.set_header(None)
            reply = await self.t.send("01" + pid, timeout=timeout)
        return parse_mode01(reply, pid)

    async def read(self, code: str) -> float | None:
        if code == "RV":
            m = re.search(r"(\d+(?:\.\d+)?)\s*V", await self.t.send("ATRV"))
            return float(m.group(1)) if m else None
        sensor = self.registry.get(code)
        if not sensor:
            return None
        return await self.read_sensor(sensor)

    async def read_sensor(self, sensor: Sensor) -> float | None:
        async with self.io:
            await self.set_header(sensor.header)
            reply = await self.t.send(sensor.cmd)
        data = parse_reply(reply, sensor.reply_prefix)
        if not data or len(data) < sensor.nbytes:
            return None
        try:
            return round(sensor.decode(data), 3)
        except (ZeroDivisionError, OverflowError, ValueError):
            return None

    async def raw(self, cmd: str, header: str | None = None) -> str:
        """Test console: send any read-only command and return the raw reply."""
        async with self.io:
            await self.set_header(header or None)
            return _clean(await self.t.send(cmd, timeout=10))

    async def read_dtcs(self) -> list[str]:
        """Stored trouble codes (mode 03). Read-only, does not clear anything."""
        async with self.io:
            await self.set_header(None)
            reply = _clean(await self.t.send("03", timeout=10))
        return parse_dtcs(reply)


    async def read_misfires(self) -> dict:
        """Per-cylinder misfire counts from the misfire monitor (mode 06, CAN cars). Read-only.

        Monitor IDs: A1 = all cylinders, A2..AD = cylinder 1..12. Test 0B = average
        misfires over the last 10 drive cycles, 0C = misfires this (or the last) drive cycle.
        """
        async with self.io:
            await self.set_header(None)
            mask = parse_reply(await self.t.send("06A0", timeout=10), "46A0")
        if not mask or len(mask) < 4:
            return {"supported": False, "cylinders": []}
        bits = int.from_bytes(bytes(mask[:4]), "big")
        mids = [0xA1 + i for i in range(32) if bits & (1 << (31 - i)) and 0xA1 + i <= 0xAD]
        out = {"supported": True, "total": None, "cylinders": []}
        for mid in mids:
            async with self.io:
                await self.set_header(None)
                reply = await self.t.send(f"06{mid:02X}", timeout=5)
            tests = parse_mode06(reply, mid)
            row = {"this_drive": tests.get(0x0C), "avg_last_10": tests.get(0x0B)}
            if mid == 0xA1:
                out["total"] = row
            else:
                out["cylinders"].append({"cyl": mid - 0xA1, **row})
        return out


def parse_mode06(reply: str, mid: int) -> dict[int, int]:
    """CAN mode 06 reply -> {test id: value}. Records are MID TID UNIT VALUE(2) MIN(2) MAX(2)."""
    data = parse_reply(reply, "46")
    tests = {}
    i = 0
    while data and i + 9 <= len(data):
        if data[i] == mid:
            tests[data[i + 1]] = data[i + 3] << 8 | data[i + 4]
        i += 9
    return tests


def _clean(text: str) -> str:
    return " ".join(line.strip() for line in text.replace("\n", "\r").split("\r") if line.strip())


def parse_mode01(reply: str, pid: str) -> list[int] | None:
    return parse_reply(reply, "41" + pid.upper())


_FRAME = re.compile(r"^[0-9A-F]:")


def parse_reply(reply: str, want: str) -> list[int] | None:
    """Find the positive reply that starts with `want` (e.g. '410C', '621E1C')."""
    lines = [l.strip().replace(" ", "").upper() for l in reply.replace("\n", "\r").split("\r")]
    lines = [l for l in lines if l]
    # Multi-frame (ISO-TP) reply: "00A", "0:621E1C...", "1:..." -> join the frames.
    if any(_FRAME.match(l) for l in lines):
        lines = ["".join(l[2:] for l in lines if _FRAME.match(l))]
    for line in lines:
        line = line.strip().replace(" ", "").upper()
        if not line or line.startswith(("SEARCHING", "BUSINIT")):
            continue
        if any(line.startswith(e.replace(" ", "")) for e in NO_DATA) or line.startswith("7F"):
            return None  # 7F = module refused the request
        i = line.find(want)  # first ECU to answer wins
        if i >= 0:
            hexdata = line[i + len(want):]
            try:
                return list(bytes.fromhex(hexdata[: len(hexdata) // 2 * 2]))
            except ValueError:
                return None
    return None


def parse_dtcs(reply: str) -> list[str]:
    s = reply.replace(" ", "").upper()
    if "43" not in s:
        return []
    codes = []
    for chunk in re.findall(r"43([0-9A-F]+)", s):
        # CAN replies include a count byte after 43; legacy ones don't.
        if len(chunk) % 4 == 2:
            chunk = chunk[2:]
        for i in range(0, len(chunk) - 3, 4):
            word = chunk[i:i + 4]
            if word == "0000":
                continue
            first = int(word[0], 16)
            codes.append("PCBU"[first >> 2] + str(first & 3) + word[1:])
    return codes
