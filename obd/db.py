"""Local SQLite database: dashboards and recorded trips.

One file (obd.db by default) next to server.py. Python ships with SQLite,
so there is nothing extra to install.
"""

import bisect
import json
import sqlite3
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trips (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT,
    started  REAL NOT NULL,
    ended    REAL
);
CREATE TABLE IF NOT EXISTS readings (
    trip_id  INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    t        REAL NOT NULL,
    code     TEXT NOT NULL,
    value    REAL
);
CREATE INDEX IF NOT EXISTS readings_trip ON readings(trip_id, t);
CREATE TABLE IF NOT EXISTS locations (
    trip_id  INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    t        REAL NOT NULL,
    lat      REAL NOT NULL,
    lon      REAL NOT NULL,
    accuracy REAL,          -- metres
    speed    REAL,          -- m/s from the phone's GPS, may be null
    heading  REAL
);
CREATE INDEX IF NOT EXISTS locations_trip ON locations(trip_id, t);
"""


class Database:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript(SCHEMA)
        self.conn.commit()
        self.trip_id: int | None = None
        # Close any trip left open by a crash or the phone killing the app.
        self.conn.execute(
            "UPDATE trips SET ended = COALESCE((SELECT MAX(t) FROM readings WHERE trip_id = trips.id), started) "
            "WHERE ended IS NULL")
        self.conn.commit()

    # ------------------------------------------------------------ settings

    def get_json(self, key: str):
        row = self.conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return json.loads(row["value"]) if row else None

    def set_json(self, key: str, value):
        self.conn.execute("INSERT INTO settings(key, value) VALUES(?, ?) "
                          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                          (key, json.dumps(value)))
        self.conn.commit()

    def import_dashboards_file(self, path: Path):
        """One-time move from the old dashboards.json file."""
        if path.exists() and self.get_json("dashboards") is None:
            self.set_json("dashboards", json.loads(path.read_text()))
            path.rename(path.with_suffix(".json.imported"))

    # ------------------------------------------------------------ trips

    @property
    def recording(self) -> bool:
        return self.trip_id is not None

    def start_trip(self, name: str | None = None) -> int:
        if self.trip_id is None:
            now = time.time()
            name = name or time.strftime("Trip %Y-%m-%d %H:%M", time.localtime(now))
            cur = self.conn.execute("INSERT INTO trips(name, started) VALUES(?, ?)", (name, now))
            self.conn.commit()
            self.trip_id = cur.lastrowid
        return self.trip_id

    def stop_trip(self):
        if self.trip_id is not None:
            self.conn.execute("UPDATE trips SET ended = ? WHERE id = ?", (time.time(), self.trip_id))
            self.conn.commit()
            self.trip_id = None

    def log(self, t: float, values: dict[str, float | None]):
        if self.trip_id is None:
            return
        rows = [(self.trip_id, t, code, v) for code, v in values.items() if v is not None]
        if rows:
            self.conn.executemany("INSERT INTO readings(trip_id, t, code, value) VALUES(?, ?, ?, ?)", rows)
            self.conn.commit()

    def log_location(self, t: float, lat: float, lon: float, accuracy=None, speed=None, heading=None):
        if self.trip_id is None:
            return
        self.conn.execute("INSERT INTO locations(trip_id, t, lat, lon, accuracy, speed, heading) "
                          "VALUES(?, ?, ?, ?, ?, ?, ?)", (self.trip_id, t, lat, lon, accuracy, speed, heading))
        self.conn.commit()

    def trip_locations(self, trip_id: int) -> list[sqlite3.Row]:
        return self.conn.execute("SELECT * FROM locations WHERE trip_id = ? ORDER BY t", (trip_id,)).fetchall()

    def trip_track(self, trip_id: int) -> list[dict]:
        """Each GPS point with the latest reading of every sensor at that moment."""
        readings = self.trip_readings(trip_id)
        points, latest, i = [], {}, 0
        for loc in self.trip_locations(trip_id):
            while i < len(readings) and readings[i]["t"] <= loc["t"]:
                latest[readings[i]["code"]] = (readings[i]["t"], readings[i]["value"])
                i += 1
            # Ignore readings older than 10 s (e.g. adapter dropped out).
            vals = {c: v for c, (t, v) in latest.items() if loc["t"] - t <= 10}
            points.append({"t": loc["t"], "lat": loc["lat"], "lon": loc["lon"],
                           "acc": loc["accuracy"], "speed": loc["speed"], "values": vals})
        return points

    def location_at(self, locs: list, times: list, t: float, max_gap: float = 10):
        """Nearest GPS fix to time t (within max_gap seconds), for CSV export."""
        j = bisect.bisect_left(times, t)
        best = None
        for k in (j - 1, j):
            if 0 <= k < len(locs) and abs(times[k] - t) <= max_gap:
                if best is None or abs(times[k] - t) < abs(best["t"] - t):
                    best = locs[k]
        return best

    def trips(self) -> list[dict]:
        rows = self.conn.execute(
            "SELECT trips.*, (SELECT COUNT(*) FROM readings WHERE trip_id = trips.id) AS n, "
            "(SELECT COUNT(*) FROM locations WHERE trip_id = trips.id) AS n_gps "
            "FROM trips ORDER BY started DESC").fetchall()
        return [dict(r) for r in rows]

    def trip_readings(self, trip_id: int):
        return self.conn.execute(
            "SELECT t, code, value FROM readings WHERE trip_id = ? ORDER BY t", (trip_id,)).fetchall()

    def delete_trip(self, trip_id: int):
        if trip_id == self.trip_id:
            self.trip_id = None
        self.conn.execute("DELETE FROM trips WHERE id = ?", (trip_id,))
        self.conn.commit()
        self.conn.execute("VACUUM")
