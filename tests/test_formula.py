import unittest

from obd.formula import compile_formula, FormulaError
from obd.pids import Registry, custom_sensor


class FormulaTests(unittest.TestCase):
    def test_basic(self):
        f = compile_formula("(A*256+B)/4")
        self.assertEqual(f([0x1A, 0xF8]), 1726.0)
        self.assertEqual(f.nbytes, 2)

    def test_signed(self):
        self.assertEqual(compile_formula("signed(A)")([0xFF]), -1)
        self.assertEqual(compile_formula("signed16(A*256+B)/16")([0xFF, 0xF0]), -1)

    def test_rejects_code(self):
        for bad in ["__import__('os')", "A.real", "open('x')", "[A]", "'x'", "X+1", "lambda: 1"]:
            with self.assertRaises(FormulaError, msg=bad):
                compile_formula(bad)

    def test_registry_loads_everything(self):
        r = Registry()
        self.assertEqual(r.errors, [])
        self.assertGreater(sum(s.standard for s in r.sensors.values()), 80)
        self.assertEqual(r.get("ford_tft").reply_prefix, "621E1C")
        self.assertEqual(r.get("0C").reply_prefix, "410C")

    def test_custom_validation(self):
        ok = custom_sensor({"code": "custom_x", "cmd": "22 1e1c", "header": "7e1", "formula": "A-40"})
        self.assertEqual((ok.cmd, ok.header), ("221E1C", "7E1"))
        for bad in [{"cmd": "04"}, {"cmd": "2E1234FF"}, {"cmd": "zz"}, {"cmd": "2211", "header": "hello"}]:
            with self.assertRaises(ValueError, msg=bad):
                custom_sensor({"code": "custom_x", **bad})


if __name__ == "__main__":
    unittest.main()


class EconomyTests(unittest.TestCase):
    def test_instant_and_average(self):
        from obd.economy import FuelEconomy, INSTANT, AVERAGE
        e = FuelEconomy()
        # 96.56 km/h (60 mph) burning 7.57 L/h (2 gal/h) = 30 mpg
        e.update({"0D": 96.56, "5E": 7.5708}, t=0)
        out = e.update({"0D": 96.56, "5E": 7.5708}, t=1)
        self.assertAlmostEqual(out[INSTANT], 30.0, delta=0.2)
        self.assertAlmostEqual(out[AVERAGE], 30.0, delta=0.2)
        self.assertEqual(e.update({"0D": 0, "5E": 0.8}, t=2)[INSTANT], 0.0)

    def test_maf_fallback(self):
        from obd.economy import fuel_lph
        self.assertAlmostEqual(fuel_lph({"10": 10.0}), 3.323, places=2)
        self.assertIsNone(fuel_lph({}))


class PowerTests(unittest.TestCase):
    def test_from_torque_pids(self):
        from obd.economy import estimate_power
        hp, lbft = estimate_power({"0C": 5252 * 1.0, "62": 100, "63": 271.16})   # 200 lb-ft at 5252 rpm = 200 hp
        self.assertAlmostEqual(hp, 200, delta=1)
        self.assertAlmostEqual(lbft, 200, delta=1)

    def test_from_maf(self):
        from obd.economy import estimate_power
        hp, _ = estimate_power({"0C": 3000, "10": 100})
        self.assertTrue(90 < hp < 130, hp)
        self.assertEqual(estimate_power({"10": 100}), (None, None))
