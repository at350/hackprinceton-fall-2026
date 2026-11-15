"""Calibration: raw volts from the probe -> the units the head model works in.

The head model reads a healthy head as COIL_HEALTHY_DB on the coil and NIR_HEALTHY on the
light channel. A calibration is the probe's raw reading on a healthy reference (the empty
phantom, or an uninjured part of the head), so:

    coil_db = COIL_HEALTHY_DB + 20 * log10(coil_v / coil_v_ref)
    nir     = NIR_HEALTHY * nir_v / nir_v_ref

This assumes the detector's output voltage follows the coil signal's amplitude, which holds
for a diode detector above its turn-on knee. It is a per-probe, per-session value: redo it
when the probe, the phantom or the room changes.
"""
from __future__ import annotations

import json
import math
import os
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from statistics import fmean
from typing import Iterable

from .protocol import RawSample

# Must equal lucid.physics.headmodel.COIL_HEALTHY_DB / NIR_HEALTHY (tests/test_device.py checks).
COIL_HEALTHY_DB = -38.2
NIR_HEALTHY = 0.612

MIN_VOLTS = 1e-4  # below this the channel is not connected or the LED is dark
PATH = Path(os.getenv("LUCID_CALIBRATION", str(Path(__file__).resolve().parents[2] / "data" / "calibration.json")))


@dataclass(frozen=True)
class Calibration:
    coil_v_ref: float
    nir_v_ref: float
    taken_at: str
    samples: int = 0

    def coil_db(self, coil_v: float) -> float:
        return COIL_HEALTHY_DB + 20.0 * math.log10(max(coil_v, MIN_VOLTS) / self.coil_v_ref)

    def nir(self, nir_v: float) -> float:
        return NIR_HEALTHY * max(nir_v, 0.0) / self.nir_v_ref


def from_samples(samples: Iterable[RawSample]) -> Calibration:
    """The mean raw reading over a still stretch on the healthy reference."""
    rows = list(samples)
    if len(rows) < 10:
        raise ValueError("Not enough samples to calibrate: hold the probe still on the reference for two seconds.")
    coil, nir = fmean(r.coil_v for r in rows), fmean(r.nir_v for r in rows)
    if coil < MIN_VOLTS:
        raise ValueError("The coil channel reads about 0 V: check the detector and the ADS1115 A0 wiring.")
    if nir < MIN_VOLTS:
        raise ValueError("The light channel reads about 0 V: check the LED, the IR receiver and the ADS1115 A1 wiring.")
    return Calibration(coil_v_ref=coil, nir_v_ref=nir, taken_at=datetime.now(UTC).isoformat(timespec="seconds"), samples=len(rows))


def save(cal: Calibration, path: Path = PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(asdict(cal), indent=2) + "\n")


def load(path: Path = PATH) -> Calibration | None:
    try:
        d = json.loads(path.read_text())
        return Calibration(coil_v_ref=float(d["coil_v_ref"]), nir_v_ref=float(d["nir_v_ref"]), taken_at=str(d["taken_at"]), samples=int(d.get("samples", 0)))
    except (OSError, ValueError, KeyError, TypeError):
        return None
