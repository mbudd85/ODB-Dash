"""Calculated sensors: instant/average MPG and estimated horsepower/torque.

Cars don't report MPG over OBD2, so it's worked out from speed (PID 0D) and
fuel flow: the car's own fuel rate (PID 5E) when it has one, otherwise the
mass air flow (PID 10) assuming petrol/gasoline burned at the ideal 14.7:1
air-fuel ratio. That assumption is good to within a few percent on most
gasoline cars, but is wrong for diesels (they run lean) and for E85.
"""

import time

INSTANT = "CALC_MPG"
AVERAGE = "CALC_AVG_MPG"
HP = "CALC_HP"
TORQUE = "CALC_TORQUE"
CODES = (INSTANT, AVERAGE, HP, TORQUE)

GASOLINE_AFR = 14.7          # kg air per kg fuel
GASOLINE_DENSITY = 737.0     # g per litre
L_PER_GAL = 3.785411784
KM_PER_MILE = 1.609344
MAX_MPG = 150.0              # coasting with the injectors off reads as "infinite"

CATALOG = [
    {"code": INSTANT, "name": "Instant fuel economy", "unit": "mpg", "min": 0, "max": 60,
     "category": "Fuel economy", "make": "Calculated", "verified": True, "cmd": "", "header": None,
     "formula": "", "nbytes": 0,
     "note": "Worked out from speed and fuel flow (fuel rate, or MAF assuming gasoline). 0 when stopped."},
    {"code": AVERAGE, "name": "Average fuel economy (this drive)", "unit": "mpg", "min": 0, "max": 60,
     "category": "Fuel economy", "make": "Calculated", "verified": True, "cmd": "", "header": None,
     "formula": "", "nbytes": 0,
     "note": "Distance ÷ fuel since the car was switched on (or the adapter reconnected)."},
    {"code": HP, "name": "Engine power (estimate)", "unit": "hp", "min": 0, "max": 400,
     "category": "Performance", "make": "Calculated", "verified": False, "cmd": "", "header": None,
     "formula": "", "nbytes": 0,
     "note": "Estimate. Uses the car's actual-torque data (PIDs 62+63) if it has them; otherwise air flow "
             "(MAF, gasoline): roughly ±20%. Engine (crank) power, not power at the wheels."},
    {"code": TORQUE, "name": "Engine torque (estimate)", "unit": "lb-ft", "min": 0, "max": 400,
     "category": "Performance", "make": "Calculated", "verified": False, "cmd": "", "header": None,
     "formula": "", "nbytes": 0,
     "note": "Estimate, same source as engine power. Torque = power ÷ RPM."},
]

# Brake-specific fuel consumption of a typical gasoline engine: lb of fuel per hp per hour.
BSFC = 0.5
NM_PER_LBFT = 1.35582


def estimate_power(values: dict, supported: set[str] = frozenset()) -> tuple[float | None, float | None]:
    """(hp, lb-ft) from torque PIDs if present, else from MAF."""
    rpm = values.get("0C")
    if rpm is None:
        return None, None
    if values.get("62") is not None and values.get("63"):
        nm = max(0.0, values["62"] / 100 * values["63"])
        hp = nm * rpm / 9549 * 1.34102
    elif values.get("10") is not None:
        fuel_lb_per_h = values["10"] * 3600 / GASOLINE_AFR / 453.592
        hp = fuel_lb_per_h / BSFC
        nm = hp / 1.34102 * 9549 / rpm if rpm > 300 else 0.0
    else:
        return None, None
    return round(hp), round(nm / NM_PER_LBFT)


def fuel_lph(values: dict) -> float | None:
    """Fuel flow in litres/hour from fuel rate (5E) or MAF (10)."""
    if values.get("5E") is not None:
        return values["5E"]
    if values.get("10") is not None:
        return values["10"] * 3600 / (GASOLINE_AFR * GASOLINE_DENSITY)
    return None


def needed(supported: set[str], calc=CODES) -> list[str]:
    """PIDs to poll for the requested calculated sensors."""
    has = lambda c: not supported or c in supported
    out = set()
    if INSTANT in calc or AVERAGE in calc:
        out |= {"0D", "5E" if has("5E") or not has("10") else "10"}
    if HP in calc or TORQUE in calc:
        out.add("0C")
        out |= {"62", "63"} if has("62") and has("63") and supported else {"10"}
    return sorted(out)


class FuelEconomy:
    def __init__(self):
        self.reset()

    def reset(self):
        self.km = 0.0
        self.litres = 0.0
        self.last_t: float | None = None

    def update(self, values: dict, t: float | None = None) -> dict:
        t = time.monotonic() if t is None else t
        speed = values.get("0D")
        lph = fuel_lph(values)
        out = {INSTANT: None, AVERAGE: None}
        if speed is None or lph is None:
            self.last_t = t
            return out
        if self.last_t is not None and 0 < t - self.last_t < 10:
            dt_h = (t - self.last_t) / 3600
            self.km += speed * dt_h
            self.litres += lph * dt_h
        self.last_t = t
        if speed < 1:
            out[INSTANT] = 0.0
        elif lph <= 0.01:
            out[INSTANT] = MAX_MPG
        else:
            mpg = (speed / KM_PER_MILE) / (lph / L_PER_GAL)
            out[INSTANT] = round(min(MAX_MPG, mpg), 1)
        if self.litres > 0.001:
            out[AVERAGE] = round(min(MAX_MPG, (self.km / KM_PER_MILE) / (self.litres / L_PER_GAL)), 1)
        return out
