"""Sensor catalog.

Three sources:
  * every numeric standard (SAE J1979, mode 01) PID — works on any 1996+ car
  * manufacturer "enhanced" sensors (mode 22) from obd/vehicles/*.json
  * custom sensors the user adds in the app (stored in the database)

A sensor is a command to send (e.g. "010C" or "221E1C"), an optional CAN
header naming which module to ask (e.g. "7E1" = transmission), and a formula
over the reply bytes A, B, C ...
"""

import json
from dataclasses import dataclass, field, asdict
from pathlib import Path

from .formula import compile_formula

VEHICLES_DIR = Path(__file__).parent / "vehicles"


@dataclass
class Sensor:
    code: str
    name: str
    unit: str
    min: float
    max: float
    formula: str
    cmd: str = ""
    header: str | None = None
    category: str = "Engine"
    make: str = "Standard"
    verified: bool = True
    note: str = ""
    fits: list | None = None        # vehicle profile ids this is known/expected to work on
    decode: object = field(default=None, repr=False, compare=False)

    def __post_init__(self):
        if not self.cmd:
            self.cmd = "01" + self.code
        self.cmd = self.cmd.upper().replace(" ", "")
        if self.header:
            self.header = self.header.upper().replace(" ", "")
        self.decode = compile_formula(self.formula)

    @property
    def nbytes(self) -> int:
        return self.decode.nbytes

    @property
    def standard(self) -> bool:
        return self.make == "Standard"

    @property
    def reply_prefix(self) -> str:
        """Positive reply = mode + 0x40, then the PID echoed back."""
        return f"{int(self.cmd[:2], 16) + 0x40:02X}{self.cmd[2:]}"

    def info(self) -> dict:
        d = asdict(self)
        d.pop("decode")
        return d


_T = "A-40"                 # temperature, °C
_P = "A*100/255"            # percent
_TRIM = "A/1.28-100"        # fuel trim %
_W = "A*256+B"              # 16-bit word

STANDARD = [
    # code, name, unit, min, max, formula, category
    ("04", "Engine load", "%", 0, 100, _P, "Engine"),
    ("05", "Coolant temp", "°C", -40, 130, _T, "Engine"),
    ("06", "Short fuel trim B1", "%", -25, 25, _TRIM, "Fuel"),
    ("07", "Long fuel trim B1", "%", -25, 25, _TRIM, "Fuel"),
    ("08", "Short fuel trim B2", "%", -25, 25, _TRIM, "Fuel"),
    ("09", "Long fuel trim B2", "%", -25, 25, _TRIM, "Fuel"),
    ("0A", "Fuel pressure", "kPa", 0, 765, "A*3", "Fuel"),
    ("0B", "Intake manifold pressure", "kPa", 0, 255, "A", "Air"),
    ("0C", "Engine RPM", "rpm", 0, 8000, f"({_W})/4", "Engine"),
    ("0D", "Vehicle speed", "km/h", 0, 240, "A", "Vehicle"),
    ("0E", "Timing advance", "°", -64, 64, "A/2-64", "Engine"),
    ("0F", "Intake air temp", "°C", -40, 80, _T, "Air"),
    ("10", "MAF air flow", "g/s", 0, 300, f"({_W})/100", "Air"),
    ("11", "Throttle position", "%", 0, 100, _P, "Engine"),
    *[(f"{0x14 + i:02X}", f"O2 sensor {i + 1} voltage", "V", 0, 1.275, "A/200", "Oxygen sensors") for i in range(8)],
    ("1F", "Run time since start", "s", 0, 7200, _W, "Vehicle"),
    ("21", "Distance with MIL on", "km", 0, 1000, _W, "Diagnostics"),
    ("22", "Fuel rail pressure (vs vacuum)", "kPa", 0, 5000, f"0.079*({_W})", "Fuel"),
    ("23", "Fuel rail pressure (direct inj.)", "kPa", 0, 30000, f"10*({_W})", "Fuel"),
    *[(f"{0x24 + i:02X}", f"O2 sensor {i + 1} lambda (wide)", "λ", 0.5, 1.5, f"2*({_W})/65536", "Oxygen sensors") for i in range(8)],
    ("2C", "Commanded EGR", "%", 0, 100, _P, "Emissions"),
    ("2D", "EGR error", "%", -100, 100, "A/1.28-100", "Emissions"),
    ("2E", "Commanded evap purge", "%", 0, 100, _P, "Emissions"),
    ("2F", "Fuel level", "%", 0, 100, _P, "Fuel"),
    ("30", "Warm-ups since codes cleared", "", 0, 255, "A", "Diagnostics"),
    ("31", "Distance since codes cleared", "km", 0, 10000, _W, "Diagnostics"),
    ("32", "Evap system vapor pressure", "Pa", -8192, 8192, f"signed16({_W})/4", "Emissions"),
    ("33", "Barometric pressure", "kPa", 0, 120, "A", "Air"),
    *[(f"{0x34 + i:02X}", f"O2 sensor {i + 1} current (wide)", "mA", -5, 5, "(C*256+D)/256-128", "Oxygen sensors") for i in range(8)],
    ("3C", "Catalyst temp B1 S1", "°C", 0, 1000, f"({_W})/10-40", "Emissions"),
    ("3D", "Catalyst temp B2 S1", "°C", 0, 1000, f"({_W})/10-40", "Emissions"),
    ("3E", "Catalyst temp B1 S2", "°C", 0, 1000, f"({_W})/10-40", "Emissions"),
    ("3F", "Catalyst temp B2 S2", "°C", 0, 1000, f"({_W})/10-40", "Emissions"),
    ("42", "Control module voltage", "V", 10, 16, f"({_W})/1000", "Electrical"),
    ("43", "Absolute load", "%", 0, 100, f"({_W})*100/255", "Engine"),
    ("44", "Commanded air-fuel ratio", "λ", 0.5, 1.5, f"({_W})/32768", "Fuel"),
    ("45", "Relative throttle", "%", 0, 100, _P, "Engine"),
    ("46", "Ambient air temp", "°C", -40, 60, _T, "Air"),
    ("47", "Absolute throttle B", "%", 0, 100, _P, "Engine"),
    ("48", "Absolute throttle C", "%", 0, 100, _P, "Engine"),
    ("49", "Accelerator pedal D", "%", 0, 100, _P, "Engine"),
    ("4A", "Accelerator pedal E", "%", 0, 100, _P, "Engine"),
    ("4B", "Accelerator pedal F", "%", 0, 100, _P, "Engine"),
    ("4C", "Commanded throttle", "%", 0, 100, _P, "Engine"),
    ("4D", "Time run with MIL on", "min", 0, 1000, _W, "Diagnostics"),
    ("4E", "Time since codes cleared", "min", 0, 10000, _W, "Diagnostics"),
    ("52", "Ethanol fuel", "%", 0, 100, _P, "Fuel"),
    ("53", "Absolute evap vapor pressure", "kPa", 0, 330, f"({_W})/200", "Emissions"),
    ("54", "Evap vapor pressure (wide)", "Pa", -32767, 32768, f"({_W})-32767", "Emissions"),
    ("55", "Short O2 trim B1", "%", -100, 100, _TRIM, "Oxygen sensors"),
    ("56", "Long O2 trim B1", "%", -100, 100, _TRIM, "Oxygen sensors"),
    ("57", "Short O2 trim B2", "%", -100, 100, _TRIM, "Oxygen sensors"),
    ("58", "Long O2 trim B2", "%", -100, 100, _TRIM, "Oxygen sensors"),
    ("59", "Fuel rail absolute pressure", "kPa", 0, 30000, f"10*({_W})", "Fuel"),
    ("5A", "Relative accelerator pedal", "%", 0, 100, _P, "Engine"),
    ("5B", "Hybrid battery remaining", "%", 0, 100, _P, "Electrical"),
    ("5C", "Engine oil temp", "°C", -40, 160, _T, "Engine"),
    ("5D", "Fuel injection timing", "°", -210, 302, f"({_W})/128-210", "Fuel"),
    ("5E", "Fuel rate", "L/h", 0, 50, f"({_W})/20", "Fuel"),
    ("61", "Driver demand torque", "%", -125, 130, "A-125", "Engine"),
    ("62", "Actual engine torque", "%", -125, 130, "A-125", "Engine"),
    ("63", "Engine reference torque", "Nm", 0, 1000, _W, "Engine"),
    ("A6", "Odometer", "km", 0, 500000, "(A*16777216+B*65536+C*256+D)/10", "Vehicle"),
]

# Not a real PID: the adapter's own reading of battery voltage at the OBD port
# (ELM327 "AT RV"). Works on every car, so it is always offered.
ADAPTER_VOLTAGE = {
    "code": "RV", "name": "Battery voltage (adapter)", "unit": "V", "min": 10, "max": 16,
    "category": "Electrical", "make": "Standard", "verified": True, "cmd": "ATRV",
    "header": None, "formula": "", "note": "Measured by the adapter itself.",
}


class Registry:
    def __init__(self):
        self.sensors: dict[str, Sensor] = {}
        self.errors: list[str] = []
        for code, name, unit, lo, hi, f, cat in STANDARD:
            self.add(Sensor(code, name, unit, lo, hi, f, category=cat))
        for path in sorted(VEHICLES_DIR.glob("*.json")):
            self.load_vehicle_file(path)

    def add(self, s: Sensor):
        self.sensors[s.code] = s

    def load_vehicle_file(self, path: Path):
        data = json.loads(path.read_text())
        for d in data["sensors"]:
            try:
                self.add(Sensor(make=data["make"], **d))
            except Exception as e:
                self.errors.append(f"{path.name} {d.get('code')}: {e}")

    def set_custom(self, items: list[dict]):
        for code in [c for c, s in self.sensors.items() if s.make == "Custom"]:
            del self.sensors[code]
        for d in items:
            try:
                self.add(custom_sensor(d))
            except Exception as e:
                self.errors.append(f"custom {d.get('name')}: {e}")

    def get(self, code: str) -> Sensor | None:
        return self.sensors.get(code)

    def catalog(self) -> list[dict]:
        out = [ADAPTER_VOLTAGE]
        for s in self.sensors.values():
            d = s.info()
            d["nbytes"] = s.nbytes
            out.append(d)
        return out


def custom_sensor(d: dict) -> Sensor:
    """Build a user-defined sensor from the app's form, validating everything."""
    code = d.get("code") or ""
    if not code.startswith("custom_"):
        raise ValueError("custom sensor codes start with custom_")
    cmd = (d.get("cmd") or "").upper().replace(" ", "")
    if cmd[:2] in ("04", "14", "11", "2E", "2F", "31", "3B"):
        raise ValueError("that command changes the car (clear codes / write / reset), so it's not allowed")
    if len(cmd) < 4 or len(cmd) % 2 or any(c not in "0123456789ABCDEF" for c in cmd):
        raise ValueError("command must be hex, e.g. 221E1C")
    header = (d.get("header") or "").upper().replace(" ", "") or None
    if header and (len(header) not in (3, 6, 8) or any(c not in "0123456789ABCDEF" for c in header)):
        raise ValueError("header must be hex, e.g. 7E0")
    return Sensor(code=code, name=d.get("name") or cmd, unit=d.get("unit") or "",
                  min=float(d.get("min") or 0), max=float(d.get("max") or 100),
                  formula=d.get("formula") or "A", cmd=cmd, header=header,
                  category=d.get("category") or "Custom", make="Custom", verified=False,
                  note=d.get("note") or "")
