"""The probe's serial protocol: one JSON object per line (see firmware/README.md)."""
from __future__ import annotations

import json
import math
from dataclasses import dataclass


@dataclass(frozen=True)
class RawSample:
    """One line from the probe: raw volts and tilt, before calibration."""

    t: int  # ms since the probe booted
    coil_v: float  # detector output, volts
    nir_v: float  # IR receiver, LED on minus LED off, volts
    pitch: float  # degrees
    roll: float  # degrees


@dataclass(frozen=True)
class Hello:
    """The probe's identification line, sent at boot and in answer to '?'."""

    fw: str
    ads: bool
    imu: bool


def _num(obj: dict, key: str) -> float:
    v = obj[key]
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise ValueError(key)
    return float(v)


def parse_line(line: str | bytes) -> RawSample | Hello | None:
    """A sample, the hello line, or None for anything else (boot noise, a cut-off line)."""
    if isinstance(line, bytes):
        line = line.decode("ascii", errors="ignore")
    line = line.strip()
    if not (line.startswith("{") and line.endswith("}")):
        return None
    try:
        obj = json.loads(line)
        if not isinstance(obj, dict):
            return None
        if obj.get("lucid") == "probe":
            return Hello(fw=str(obj.get("fw", "")), ads=bool(obj.get("ads", False)), imu=bool(obj.get("imu", False)))
        return RawSample(t=int(_num(obj, "t")), coil_v=_num(obj, "coil_v"), nir_v=_num(obj, "nir_v"), pitch=_num(obj, "pitch"), roll=_num(obj, "roll"))
    except (ValueError, KeyError, TypeError):
        return None
