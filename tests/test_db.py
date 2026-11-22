import json
import tempfile
import unittest
from pathlib import Path

from obd.db import Database


class DbTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.db = Database(self.dir / "t.db")

    def test_dashboards_roundtrip(self):
        self.assertIsNone(self.db.get_json("dashboards"))
        self.db.set_json("dashboards", {"dashboards": [1]})
        self.db.set_json("dashboards", {"dashboards": [2]})
        self.assertEqual(self.db.get_json("dashboards"), {"dashboards": [2]})

    def test_import_old_file(self):
        f = self.dir / "dashboards.json"
        f.write_text(json.dumps({"dashboards": ["x"]}))
        self.db.import_dashboards_file(f)
        self.assertEqual(self.db.get_json("dashboards"), {"dashboards": ["x"]})
        self.assertFalse(f.exists())

    def test_trip_logging(self):
        self.db.log(1.0, {"0C": 900})  # not recording: ignored
        tid = self.db.start_trip()
        self.db.log(2.0, {"0C": 1000, "0D": 30, "05": None})
        self.db.stop_trip()
        self.db.log(3.0, {"0C": 1100})
        trips = self.db.trips()
        self.assertEqual(len(trips), 1)
        self.assertEqual(trips[0]["n"], 2)
        self.db.delete_trip(tid)
        self.assertEqual(self.db.trips(), [])

    def test_open_trip_closed_on_restart(self):
        self.db.start_trip()
        self.db.log(5.0, {"0C": 1})
        db2 = Database(self.dir / "t.db")
        self.assertIsNotNone(db2.trips()[0]["ended"])




class LocationTests(unittest.TestCase):
    def test_track_joins_readings(self):
        db = Database(Path(tempfile.mkdtemp()) / "t.db")
        db.log_location(1.0, 1, 2)            # not recording: ignored
        tid = db.start_trip()
        db.log(10.0, {"0D": 50})
        db.log_location(10.5, 51.5, -0.1, 5, 13.9)
        db.log(11.0, {"0D": 55, "0C": 2000})
        db.log_location(11.5, 51.6, -0.2)
        db.log_location(30.0, 51.7, -0.3)     # readings now >10 s old: dropped
        pts = db.trip_track(tid)
        self.assertEqual([p["values"] for p in pts], [{"0D": 50}, {"0D": 55, "0C": 2000}, {}])
        self.assertEqual(db.trips()[0]["n_gps"], 3)
        locs = db.trip_locations(tid)
        self.assertEqual(db.location_at(locs, [l["t"] for l in locs], 11.0)["lat"], 51.5)


if __name__ == "__main__":
    unittest.main()


class GpsParseTests(unittest.TestCase):
    def test_tpv(self):
        from obd.gps import parse_tpv
        fix = parse_tpv(b'{"class":"TPV","mode":3,"lat":42.33,"lon":-83.04,"speed":12.5,"track":90,"eph":4.2}')
        self.assertEqual((fix["lat"], fix["lon"], fix["speed"], fix["acc"]), (42.33, -83.04, 12.5, 4.2))
        self.assertIsNone(parse_tpv(b'{"class":"TPV","mode":1}'))
        self.assertIsNone(parse_tpv(b'{"class":"SKY"}'))
        self.assertIsNone(parse_tpv(b'not json'))
