import asyncio
import unittest

from obd.elm327 import Elm327, TcpTransport, parse_mode01, parse_dtcs
from obd.simulator import SimTransport


class ParseTests(unittest.TestCase):
    def test_rpm_no_spaces(self):
        self.assertEqual(parse_mode01("410C1AF8\r\r", "0C"), [0x1A, 0xF8])

    def test_spaces_and_searching(self):
        self.assertEqual(parse_mode01("SEARCHING...\r41 0D 32 \r\r", "0D"), [0x32])

    def test_no_data(self):
        self.assertIsNone(parse_mode01("NO DATA\r\r", "0C"))

    def test_multiple_ecus_first_wins(self):
        self.assertEqual(parse_mode01("410C0FA0\r410C0FA4\r", "0C"), [0x0F, 0xA0])

    def test_dtcs_can(self):
        self.assertEqual(parse_dtcs("43 02 01 33 C1 23"), ["P0133", "U0123"])

    def test_dtcs_legacy(self):
        self.assertEqual(parse_dtcs("43 01 33 00 00 00 00"), ["P0133"])

    def test_dtcs_none(self):
        self.assertEqual(parse_dtcs("NO DATA"), [])


class FakeAdapterOverTcp(unittest.IsolatedAsyncioTestCase):
    """Run the simulator behind a real TCP socket, like the Veepeak on port 35000."""

    async def asyncSetUp(self):
        sim = SimTransport(latency=0)

        async def handle(reader, writer):
            buf = b""
            while data := await reader.read(100):
                buf += data
                while b"\r" in buf:
                    cmd, buf = buf.split(b"\r", 1)
                    writer.write((await sim.send(cmd.decode())).encode() + b">")
                    await writer.drain()
        self.server = await asyncio.start_server(handle, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]

    async def asyncTearDown(self):
        self.server.close()

    async def test_full_session(self):
        elm = Elm327(TcpTransport("127.0.0.1", self.port))
        await elm.connect()
        self.assertIn("ELM327", elm.version)
        self.assertIn("0C", elm.supported)
        self.assertNotIn("0A", elm.supported)
        rpm = await elm.read("0C")
        self.assertTrue(700 <= rpm <= 8000, rpm)
        self.assertIsNotNone(await elm.read("RV"))
        self.assertIsNone(await elm.read("0A"))
        self.assertEqual(await elm.read_dtcs(), ["P0133"])
        await elm.close()


if __name__ == "__main__":
    unittest.main()


class EnhancedTests(unittest.IsolatedAsyncioTestCase):
    async def test_ford_sensors_via_simulator(self):
        elm = Elm327(SimTransport(latency=0))
        await elm.connect()
        tft = await elm.read("ford_tft")
        self.assertTrue(30 <= tft <= 100, tft)
        self.assertEqual(elm.header, "7E1")
        self.assertEqual(await elm.read("ford_oil_life"), 72)
        self.assertIsNone(await elm.read("mazda_atf_temp_alt"))   # refused (7F) -> None
        rpm = await elm.read("0C")                                  # back to broadcast header
        self.assertIsNone(elm.header)
        self.assertTrue(rpm > 500)

    def test_parse_multiframe(self):
        from obd.elm327 import parse_reply
        reply = "008\r0:62DD0100123\r1:4500000000\r"
        self.assertEqual(parse_reply(reply, "62DD01")[:4], [0x00, 0x12, 0x34, 0x50])

    def test_negative_response(self):
        from obd.elm327 import parse_reply
        self.assertIsNone(parse_reply("7F2231\r", "621E1C"))


class Mode06Tests(unittest.TestCase):
    def test_parse_records(self):
        from obd.elm327 import parse_mode06
        reply = "46A40B2400020000FFFFA40C2400050000FFFF\r\r"
        self.assertEqual(parse_mode06(reply, 0xA4), {0x0B: 2, 0x0C: 5})

    def test_sim_misfires(self):
        import asyncio
        from obd.elm327 import Elm327
        from obd.simulator import SimTransport
        async def go():
            elm = Elm327(SimTransport(latency=0))
            return await elm.read_misfires()
        m = asyncio.run(go())
        self.assertEqual([c["cyl"] for c in m["cylinders"]], [1, 2, 3, 4])
        self.assertEqual(m["cylinders"][2]["this_drive"], 4)
        self.assertEqual(m["total"]["this_drive"], 5)
