"""Spot capture: turn the probe's sample stream into one reading per scan spot.

The probe cannot know where on the head it is, so the dashboard asks for the spots in
order and this tracker decides when each one is done:

  1. The medic places the probe on the spot the dashboard shows.
  2. When the probe has been still for HOLD_S, the spot's reading is the mean over that window.
  3. The probe must move before the next spot can be captured, so holding still takes one reading.

Contact is graded from the noise inside the window: a steady signal is "good", a noisy one "weak".
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from statistics import fmean, pstdev
from typing import Iterable

from . import N_SPOTS, SPOT_NAMES

HOLD_S = 1.0  # still for this long = the spot is read
STILL_DEG = 2.5  # pitch and roll each stay within this range over the window
MOVE_DEG = 8.0  # tilt change that counts as "moved to the next spot"
WEAK_COIL_DB = 0.15  # coil noise (std) above this in the window: weak contact
WEAK_NIR = 0.010  # NIR noise (std) above this: weak contact
MIN_WINDOW_SAMPLES = 20  # at 50 Hz, a full window is about 50


@dataclass(frozen=True)
class Sample:
    """One calibrated sample."""

    t: int  # ms
    coil_db: float
    nir: float
    pitch: float
    roll: float


def _range(values: Iterable[float]) -> float:
    vs = list(values)
    return max(vs) - min(vs)


class SpotTracker:
    """Feeds on samples; while a scan is running, captures the queued spots one by one."""

    def __init__(self) -> None:
        self.window: deque[Sample] = deque()
        self.queue: list[int] = []  # spots still to capture, in order
        self.readings: dict[int, dict] = {}
        self._pose: tuple[float, float] | None = None  # tilt at the last capture
        self._armed = True

    # -- scan control --
    def start(self, spots: Iterable[int] | None = None) -> None:
        """Begin capturing. No argument: a fresh scan of all 8 spots. With spots: read those again."""
        wanted = list(range(N_SPOTS)) if spots is None else sorted({int(s) for s in spots})
        if any(s < 0 or s >= N_SPOTS for s in wanted):
            raise ValueError(f"Spots are numbered 0 to {N_SPOTS - 1}.")
        if spots is None:
            self.readings = {}
        else:
            for s in wanted:
                self.readings.pop(s, None)
        self.queue = wanted
        self.window.clear()
        self._armed = True
        self._pose = None

    @property
    def scanning(self) -> bool:
        return bool(self.queue)

    @property
    def current(self) -> int | None:
        return self.queue[0] if self.queue else None

    @property
    def complete(self) -> bool:
        return not self.queue and len(self.readings) == N_SPOTS

    def spots(self) -> list[dict]:
        return [self.readings[i] for i in sorted(self.readings)]

    # -- stream --
    def motion(self) -> float:
        """Largest tilt range over the current window, degrees."""
        if len(self.window) < 2:
            return 0.0
        return max(_range(s.pitch for s in self.window), _range(s.roll for s in self.window))

    def quality(self) -> str:
        """Live contact grade for the charts: good, weak (unsteady) or bad (moving)."""
        m = self.motion()
        if m > MOVE_DEG:
            return "bad"
        if m > STILL_DEG or self._noisy():
            return "weak"
        return "good"

    def _noisy(self) -> bool:
        if len(self.window) < MIN_WINDOW_SAMPLES:
            return False
        return pstdev(s.coil_db for s in self.window) > WEAK_COIL_DB or pstdev(s.nir for s in self.window) > WEAK_NIR

    def feed(self, s: Sample) -> dict | None:
        """Add one sample. Returns the spot reading when this sample completes a spot."""
        if self.window and s.t < self.window[-1].t:  # the probe rebooted: its clock restarted
            self.window.clear()
        self.window.append(s)
        while self.window and s.t - self.window[0].t > HOLD_S * 1000:
            self.window.popleft()
        if not self.queue:
            return None
        if not self._armed:
            moved = self._pose is None or max(abs(s.pitch - self._pose[0]), abs(s.roll - self._pose[1])) > MOVE_DEG
            if moved or self.motion() > MOVE_DEG:
                self._armed = True
                self.window.clear()
                self.window.append(s)
            return None
        full = len(self.window) >= MIN_WINDOW_SAMPLES and s.t - self.window[0].t >= HOLD_S * 1000 * 0.9
        if not full or self.motion() > STILL_DEG:
            return None
        index = self.queue.pop(0)
        reading = {
            "index": index,
            "name": SPOT_NAMES[index],
            "angle": index * 45,
            "coil_db": round(fmean(x.coil_db for x in self.window), 2),
            "nir": round(fmean(x.nir for x in self.window), 4),
            "quality": "weak" if self._noisy() else "good",
        }
        self.readings[index] = reading
        self._pose = (fmean(x.pitch for x in self.window), fmean(x.roll for x in self.window))
        self._armed = False
        return reading
