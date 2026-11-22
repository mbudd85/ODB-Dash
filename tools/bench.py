"""Speed test for the OBD adapter (read-only). Stop OBD Dash first: the Veepeak takes one client.

    py -3.11 tools/bench.py [--host 192.168.0.10] [--port 35000]

Prints how long different request styles take, so we can pick the fastest one for this car.
"""
import argparse
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from obd.elm327 import TcpTransport, _clean  # noqa: E402

TESTS = [
    ("single, broadcast", None, "010C"),
    ("single, engine only", "7E0", "010C"),
    ("single, engine only, count 1", "7E0", "010C1"),
    ("3 PIDs, engine only", "7E0", "010C0D11"),
    ("3 PIDs, engine only, count 1", "7E0", "010C0D111"),
    ("6 PIDs, engine only", "7E0", "010C0D110B0504"),
    ("6 PIDs, engine only, count 2", "7E0", "010C0D110B05042"),
]


async def main(host, port, n):
    t = TcpTransport(host, port)
    await t.open()
    for cmd in ("ATZ", "ATE0", "ATL0", "ATS0", "ATH0", "ATSP0"):
        await t.send(cmd, timeout=10)
    print("first query (protocol search):", _clean(await t.send("0100", timeout=15)))
    print("protocol:", _clean(await t.send("ATDP")), "/", _clean(await t.send("ATDPN")))
    for timing in ("ATAT1", "ATAT2"):
        print(f"\n== {timing}: {_clean(await t.send(timing))}")
        header = "?"
        for name, hdr, cmd in TESTS:
            if hdr != header:
                await t.send("ATSH" + (hdr or "7DF"))
                header = hdr
            times, reply = [], ""
            for _ in range(n):
                t0 = time.perf_counter()
                reply = await t.send(cmd)
                times.append((time.perf_counter() - t0) * 1000)
            times.sort()
            print(f"{name:32s} median {times[len(times)//2]:6.0f} ms   reply: {_clean(reply)[:60]}")
    await t.send("ATSH7DF")
    await t.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="192.168.0.10")
    ap.add_argument("--port", type=int, default=35000)
    ap.add_argument("-n", type=int, default=10)
    a = ap.parse_args()
    asyncio.run(main(a.host, a.port, a.n))
