"""A fake ELM327 adapter so the app can be tried without a car.

It answers the same text protocol as the real adapter, so the parsing code
is exercised exactly as it would be against the Veepeak.
"""

import asyncio
import math
import random
import time

SIM_PIDS = ["04", "05", "06", "07", "0B", "0C", "0D", "0E", "0F", "10", "11",
            "1F", "21", "2F", "31", "33", "42", "43", "44", "45", "46", "49", "4C", "5C", "5E"]


class SimulatedCar:
    def __init__(self):
        self.t0 = time.monotonic()
        self.last = self.t0
        self.speed = 0.0        # km/h
        self.rpm = 800.0
        self.throttle = 0.0     # %
        self.coolant = 20.0
        self.oil = 18.0
        self.fuel = 63.0
        self.distance = 1234.0

    def step(self):
        now = time.monotonic()
        dt, self.last = now - self.last, now
        t = now - self.t0
        # A 60 s loop: pull away, cruise, accelerate hard, brake, idle.
        phase = t % 60
        if phase < 10:
            target, self.throttle = 50, 35
        elif phase < 25:
            target, self.throttle = 60, 18
        elif phase < 35:
            target, self.throttle = 110, 80
        elif phase < 48:
            target, self.throttle = 0, 0
        else:
            target, self.throttle = 0, 0
        self.throttle += random.uniform(-2, 2)
        self.throttle = max(0, min(100, self.throttle))
        self.speed += (target - self.speed) * min(1, dt * 0.35)
        gear_ratio = [0, 110, 65, 45, 35, 28, 24][min(6, 1 + int(self.speed // 22))]
        self.rpm = max(780, self.speed * gear_ratio) + random.uniform(-25, 25)
        self.coolant += (90 - self.coolant) * min(1, dt * 0.02)
        self.oil += (100 - self.oil) * min(1, dt * 0.012)
        self.fuel = max(0, self.fuel - dt * 0.002)
        self.distance += self.speed * dt / 3600
        self.runtime = t

    def values(self) -> dict[str, list[int]]:
        self.step()
        load = min(100, 18 + self.throttle * 0.75)
        maf = self.rpm * load / 2200
        return {
            "04": [_u8(load * 2.55)],
            "05": [_u8(self.coolant + 40)],
            "06": [_u8((random.uniform(-4, 4) + 100) * 1.28)],
            "07": [_u8((2.3 + 100) * 1.28)],
            "0B": [_u8(30 + load * 0.7)],
            "0C": _u16(self.rpm * 4),
            "0D": [_u8(self.speed)],
            "0E": [_u8((12 + random.uniform(-3, 3) + 64) * 2)],
            "0F": [_u8(28 + 40)],
            "10": _u16(maf * 100),
            "11": [_u8((14 + self.throttle * 0.8) * 2.55)],
            "1F": _u16(self.runtime),
            "21": _u16(0),
            "2F": [_u8(self.fuel * 2.55)],
            "31": _u16(self.distance),
            "33": [101],
            "42": _u16((14.1 + 0.15 * math.sin(self.runtime)) * 1000),
            "43": _u16(load * 2.55),
            "44": _u16(32768),
            "45": [_u8(self.throttle * 2.55)],
            "46": [_u8(18 + 40)],
            "49": [_u8((15 + self.throttle * 0.8) * 2.55)],
            "4C": [_u8(self.throttle * 2.55)],
            "5C": [_u8(self.oil + 40)],
            "5E": _u16((0.8 + maf * 0.09) * 20),
        }


def _u8(x) -> int:
    return max(0, min(255, int(round(x))))


def _u16(x) -> list[int]:
    v = max(0, min(65535, int(round(x))))
    return [v >> 8, v & 0xFF]


def _support_mask(base: int) -> str:
    mask = 0
    for code in SIM_PIDS + ["20", "40"]:
        n = int(code, 16)
        if base < n <= base + 32:
            mask |= 1 << (31 - (n - base - 1))
    return f"{mask:08X}"


class SimTransport:
    """Drop-in replacement for TcpTransport."""

    def __init__(self, latency: float = 0.03):
        self.car = SimulatedCar()
        self.latency = latency
        self.lock = asyncio.Lock()
        self.header = "7DF"

    async def open(self):
        await asyncio.sleep(0.2)

    async def close(self):
        pass

    async def send(self, cmd: str, timeout: float | None = None) -> str:
        async with self.lock:
            await asyncio.sleep(self.latency)
            return self._answer(cmd.strip().upper().replace(" ", ""))

    def _answer(self, cmd: str) -> str:
        if cmd == "ATZ":
            return "\r\rELM327 v1.5 (simulator)\r\r"
        if cmd == "ATRV":
            return f"{12.4 + random.uniform(1.5, 1.8):.1f}V\r\r"
        if cmd.startswith("ATSH"):
            self.header = cmd[4:]
            return "OK\r\r"
        if cmd == "ATDP":
            return "AUTO, ISO 15765-4 (CAN 11/500)\r\r"
        if cmd.startswith("AT"):
            return "OK\r\r"
        if cmd.startswith("22"):
            return self._enhanced(cmd[2:])
        if cmd == "06A0":
            return "46A0F8000000\r\r"   # misfire monitor: all + cylinders 1-4
        if cmd.startswith("06A") and len(cmd) == 4 and cmd[3] in "12345":
            mid = int(cmd[2:], 16)
            cyl = mid - 0xA1
            now, avg = {0: (5, 2), 3: (4, 2)}.get(cyl, (0, 0))   # cylinder 3 misfires a little
            return "46" + "".join(f"{mid:02X}{tid:02X}24{v:04X}0000FFFF" for tid, v in ((0x0B, avg), (0x0C, now))) + "\r\r"
        if cmd == "03":
            return "43010133\r\r"  # one stored code: P0133 (O2 sensor slow response)
        if cmd.startswith("01") and len(cmd) == 4:
            pid = cmd[2:]
            n = int(pid, 16)
            if n % 0x20 == 0 and n <= 0x40:
                return f"41{pid}{_support_mask(n)}\r\r"
            vals = self.car.values()
            if pid in vals:
                return "41" + pid + "".join(f"{b:02X}" for b in vals[pid]) + "\r\r"
            return "NO DATA\r\r"
        return "?\r\r"

    def _enhanced(self, did: str) -> str:
        """A pretend Ford: answers a few mode 22 sensors from the right module."""
        car = self.car
        car.step()
        tft = round((40 + min(50, car.runtime / 6)) * 16)   # warms 40 -> 90 °C
        gear = 0 if car.speed < 2 else min(6, 1 + int(car.speed // 22))
        odo = int(car.distance)
        table = {
            ("7E1", "1E1C"): [tft >> 8, tft & 0xFF],
            ("7E1", "1E12"): [gear],
            ("7E0", "054B"): [72],
            ("7E0", "DD01"): [odo >> 16, (odo >> 8) & 0xFF, odo & 0xFF],
            ("726", "4028"): [86],
        }
        data = table.get((self.header, did))
        if data is None:
            return "NO DATA\r\r" if self.header not in ("7E0", "7E1", "726") else f"7F2231\r\r"
        return "62" + did + "".join(f"{b:02X}" for b in data) + "\r\r"
