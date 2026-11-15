"""The device bridge: one place that knows whether a probe is there, what it is reading and where the scan stands."""
from __future__ import annotations

import threading
import time
from collections import deque

from . import N_SPOTS, calibrate
from .calibrate import Calibration
from .protocol import RawSample
from .reader import Source
from .spots import Sample, SpotTracker

KEEP = 1500  # samples kept for the charts (30 s at 50 Hz)
CAL_WINDOW_S = 2.0


class Bridge:
    def __init__(self, calibration: Calibration | None = None) -> None:
        self.lock = threading.RLock()
        self.source: Source | None = None
        self.cal = calibration
        self.provisional: Calibration | None = None  # charts only, until a real calibration exists
        self.raw: deque[RawSample] = deque(maxlen=KEEP)
        self.out: deque[dict] = deque(maxlen=KEEP)
        self.tracker = SpotTracker()
        self.seq = 0
        self.scan_started: float | None = None
        self.last_sample_at = 0.0

    # -- samples in --
    def on_sample(self, r: RawSample) -> None:
        with self.lock:
            self.raw.append(r)
            self.last_sample_at = time.monotonic()
            cal = self.cal or self._provisional()
            if cal is None:
                return
            s = Sample(t=r.t, coil_db=cal.coil_db(r.coil_v), nir=cal.nir(r.nir_v), pitch=r.pitch, roll=r.roll)
            spot_before = self.tracker.current
            self.tracker.feed(s)
            self.seq += 1
            self.out.append(
                {
                    "seq": self.seq,
                    "t": r.t,
                    "coil_db": round(s.coil_db, 2),
                    "nir": round(s.nir, 4),
                    "imu": {"pitch": r.pitch, "roll": r.roll},
                    "spot": spot_before if spot_before is not None else 0,
                    "quality": self.tracker.quality(),
                }
            )

    def _provisional(self) -> Calibration | None:
        if self.provisional is None and len(self.raw) >= 25:
            try:
                self.provisional = calibrate.from_samples(list(self.raw)[-25:])
            except ValueError:
                return None
        return self.provisional

    # -- what the dashboard and the agent ask --
    def status(self) -> dict:
        with self.lock:
            src = self.source
            connected = bool(src and src.connected)
            reason = "" if connected else (src.reason if src else "No device bridge source")
            if connected and self.cal is None:
                reason = "Not calibrated: hold the probe on the healthy reference and calibrate"
            t = self.tracker
            return {
                "connected": connected,
                "reason": reason,
                "port": src.port if src else None,
                "firmware": src.hello.fw if src and src.hello else None,
                "calibrated": self.cal is not None,
                "calibration": {"taken_at": self.cal.taken_at, "coil_v_ref": round(self.cal.coil_v_ref, 4), "nir_v_ref": round(self.cal.nir_v_ref, 4)} if self.cal else None,
                "scanning": t.scanning,
                "spot": t.current,
                "done": sorted(t.readings),
                "complete": t.complete,
                "seq": self.seq,
            }

    def samples(self, since: int = 0, limit: int = 500) -> list[dict]:
        with self.lock:
            rows = [s for s in self.out if s["seq"] > since]
            return rows[-limit:]

    def calibrate(self, seconds: float = CAL_WINDOW_S) -> Calibration:
        """Take the last `seconds` of raw samples as the healthy reference, and save it."""
        with self.lock:
            if not self.raw:
                raise ValueError("No readings from the probe yet.")
            newest = self.raw[-1].t
            rows = [r for r in self.raw if newest - r.t <= seconds * 1000]
            cal = calibrate.from_samples(rows)
            self.cal = cal
            self.tracker = SpotTracker()
            calibrate.save(cal)
            return cal

    def start_scan(self, spots: list[int] | None = None) -> dict:
        with self.lock:
            if not (self.source and self.source.connected):
                raise ValueError("No probe connected.")
            if self.cal is None:
                raise ValueError("Calibrate first: the readings have no healthy reference yet.")
            if spots is not None and len(self.tracker.readings) < N_SPOTS and not self.tracker.scanning:
                raise ValueError("No completed scan to re-scan spots of.")
            self.tracker.start(spots)
            self.scan_started = time.time()
            return self.scan()

    def scan(self) -> dict:
        with self.lock:
            t = self.tracker
            return {"complete": t.complete, "scanning": t.scanning, "spot": t.current, "spots": t.spots(), "started_at": self.scan_started}
