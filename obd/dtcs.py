"""Trouble code (DTC) library: generic titles, manufacturer codes and troubleshooting help.

Source files live in obd/dtc/. tools/build_dtcs.py packs them into static/dtc-data.js, which the
dashboard (PC and Fire tablet) uses to explain codes offline. static/dtc.js does the lookup.
"""
import json
import re
from pathlib import Path

DIR = Path(__file__).parent / "dtc"
CODE = re.compile(r"^[PBCU][0-3][0-9A-F]{3}$")
RANGE = re.compile(r"^([PBCU][0-3][0-9A-F]{3})(?:-([PBCU][0-3][0-9A-F]{3}))?$")


def load() -> dict:
    generic = {}
    for line in (DIR / "generic.txt").read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        code, title = line.split("|", 1)
        if code in generic:
            raise ValueError(f"duplicate generic code {code}")
        generic[code] = title
    makes = json.loads((DIR / "makes.json").read_text(encoding="utf-8"))
    help_ = json.loads((DIR / "help.json").read_text(encoding="utf-8"))
    return {"generic": generic, "makes": makes, "help": {k: v for k, v in help_.items() if not k.startswith("_")},
            "about": makes.get("_about", "")}


def validate(data: dict) -> list[str]:
    errors = []
    for code in data["generic"]:
        if not CODE.match(code):
            errors.append(f"bad generic code {code}")
    groups = data["makes"]["groups"]
    for name, g in groups.items():
        if not g.get("makes"):
            errors.append(f"{name}: no makes listed")
        for code in g["codes"]:
            if not CODE.match(code):
                errors.append(f"{name}: bad code {code}")
    for key, h in data["help"].items():
        m = RANGE.match(key)
        if not m:
            errors.append(f"help: bad key {key}")
            continue
        if m.group(2) and m.group(2) < m.group(1):
            errors.append(f"help: range backwards {key}")
        if h.get("sev") not in (1, 2, 3):
            errors.append(f"help {key}: sev must be 1, 2 or 3")
        if not h.get("what"):
            errors.append(f"help {key}: missing 'what'")
        if "same" in h and h["same"] not in data["help"]:
            errors.append(f"help {key}: 'same' points to missing {h['same']}")
        if "same" not in h and not (h.get("causes") and h.get("checks")):
            errors.append(f"help {key}: needs causes and checks (or 'same')")
        for gname in list(h.get("notes", {})) + h.get("only", []):
            if gname not in groups:
                errors.append(f"help {key}: unknown maker group {gname}")
    return errors
