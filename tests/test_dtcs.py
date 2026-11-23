import json
import shutil
import subprocess
import unittest
from pathlib import Path

from obd.dtcs import load, validate

ROOT = Path(__file__).resolve().parent.parent


class DtcDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = load()

    def test_valid(self):
        self.assertEqual(validate(self.data), [])

    def test_known_titles(self):
        g = self.data["generic"]
        self.assertEqual(g["P2272"], "O2 Sensor Signal Biased/Stuck Lean (Bank 2 Sensor 2)")
        self.assertEqual(g["P0420"], "Catalyst System Efficiency Below Threshold (Bank 1)")
        self.assertEqual(g["P0304"], "Cylinder 4 Misfire Detected")
        self.assertEqual(g["P0266"], "Cylinder 2 Contribution/Balance")
        self.assertIn("Body Control Module", g["U0140"])
        self.assertGreater(len(g), 900)

    def test_every_requested_make_has_a_group(self):
        groups = self.data["makes"]["groups"]
        makes = {m.lower() for grp in groups.values() for m in grp["makes"]}
        for m in ["Ford", "Mazda", "Jeep", "Dodge", "Chevrolet", "Chevy", "Acura", "Hyundai", "Chrysler", "Ram",
                  "Toyota", "Lexus", "Subaru", "Kia", "Volkswagen", "GMC", "BMW", "Honda", "Nissan"]:
            self.assertIn(m.lower(), makes, m)

    def test_generated_file_is_current(self):
        js = (ROOT / "static" / "dtc-data.js").read_text(encoding="utf-8")
        blob = json.loads(js.split("const OBD_DTC_DATA = ", 1)[1].rstrip().rstrip(";"))
        self.assertEqual(blob, self.data, "run python tools/build_dtcs.py")


@unittest.skipUnless(shutil.which("node"), "node not installed")
class DtcLookupJsTests(unittest.TestCase):
    """Run static/dtc.js in node and check a few lookups."""

    def lookup(self, code, make=""):
        script = f"""
global.window = {{}};
const fs = require("fs");
eval(fs.readFileSync("static/dtc-data.js", "utf8").replace("const OBD_DTC_DATA", "global.OBD_DTC_DATA"));
eval(fs.readFileSync("static/dtc.js", "utf8"));
const r = window.OBDDtc.lookup({json.dumps(code)}, {json.dumps(make)});
window.OBDDtc.render({json.dumps(code)}, {json.dumps(make)});
console.log(JSON.stringify(r));
"""
        out = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, check=True).stdout
        return json.loads(out)

    def test_generic_with_help(self):
        r = self.lookup("P2272", "Ford")
        self.assertEqual(r["source"], "generic")
        self.assertFalse(r["general"])
        self.assertTrue(r["causes"] and r["checks"])
        self.assertEqual([n["group"] for n in r["notes"]], ["Ford"])

    def test_manufacturer_code_depends_on_make(self):
        self.assertIn("crankcase", self.lookup("P1491", "Subaru")["title"])
        self.assertIn("fan", self.lookup("P1491", "Dodge")["title"])
        anyone = self.lookup("P1491")
        self.assertIsNone(anyone["title"])
        self.assertEqual({o["group"] for o in anyone["others"]}, {"Chrysler", "Honda", "Subaru"})

    def test_unknown_code_still_gets_advice(self):
        r = self.lookup("P1F23", "Toyota")
        self.assertIsNone(r["title"])
        self.assertTrue(r["general"] and r["checks"])

    def test_body_code_with_failure_type(self):
        self.assertEqual(self.lookup("B1342-13", "Ford")["code"], "B1342")
