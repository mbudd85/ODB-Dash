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
