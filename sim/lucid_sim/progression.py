"""How a bleed might progress over the next hours, under different conditions.

The shape follows well-known patterns, with ballpark numbers:
- an epidural bleed is arterial and can grow fast in the first hours;
- an acute subdural grows more slowly;
- about a third of deep (intracerebral) bleeds expand early, mostly in the first few hours;
- blood thinners and high blood pressure make growth more likely and larger;
- treatment (blood-pressure control, reversing blood thinners) cuts the growth still to come;
- surgery removes most of the volume.

Each run is random: whether this bleed expands, by how much, and how fast. Many runs give a spread.
Midline shift is a rough linear mass effect. What Lucid would read comes from the same coil sensitivity as
the simulator, so "when would the probe flag it" is consistent with the rest of the code.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .anatomy import HUMAN, Bleed, Spot
from .channels import CoilModel

# Expansion chance, mean extra volume as a fraction of the start, time constant (h).
GROWTH = {
    "epidural": (0.55, 0.9, 1.5),
    "subdural": (0.35, 0.5, 4.0),
    "intracerebral": (0.33, 0.6, 3.0),
    "balloon": (0.0, 0.0, 1.0),
}
MLS_MM_PER_ML = 0.15  # midline shift per ml of blood, rough (30 ml ~ 4.5 mm)
GUIDE_VOLUME_ML = 30.0  # common surgical reference lines in guidelines, for orientation only
GUIDE_MLS_MM = 5.0
FLAG_Z = 3.0
PAIR_SE = 0.02  # S/m: typical left/right standard error, measurement plus natural asymmetry


@dataclass(frozen=True)
class Conditions:
    name: str
    blood_thinners: bool = False
    high_bp: bool = False
    treat_at_h: float | None = None  # blood-pressure control / reversal starts
    surgery_at_h: float | None = None

    def describe(self) -> str:
        parts = []
        parts.append("on blood thinners" if self.blood_thinners else "no blood thinners")
        if self.high_bp:
            parts.append("high blood pressure")
        parts.append(f"treated at {self.treat_at_h:g} h" if self.treat_at_h is not None else "no treatment")
        if self.surgery_at_h is not None:
            parts.append(f"surgery at {self.surgery_at_h:g} h")
        return ", ".join(parts)


PRESETS = (
    Conditions("No treatment"),
    Conditions("Treated at 1 h, after a Lucid flag", treat_at_h=1.0),
    Conditions("Treated at 4 h, waiting for CT", treat_at_h=4.0),
)


def simulate_growth(volume_ml: float, kind: str, cond: Conditions, hours: float = 12.0, dt_h: float = 0.1,
                    n: int = 300, seed: int | None = 0) -> tuple[np.ndarray, np.ndarray]:
    """Volume over time for `n` random runs: (t (T,), volume (n, T))."""
    rng = np.random.default_rng(seed)
    p, frac, tau = GROWTH[kind]
    if cond.blood_thinners:
        p, frac, tau = min(0.9, p * 1.7), frac * 1.8, tau * 1.5
    if cond.high_bp:
        p, frac = min(0.9, p * 1.25), frac * 1.3
    t = np.arange(0, hours + 1e-9, dt_h)
    expands = rng.random(n) < p
    extra = np.where(expands, rng.lognormal(np.log(max(frac, 1e-6)), 0.5, n), rng.uniform(0, 0.08, n)) * volume_ml
    rate = 1 / (tau * rng.lognormal(0, 0.35, n))  # per hour
    vol = np.empty((n, len(t)))
    v = np.full(n, float(volume_ml))
    target = volume_ml + extra
    for k, tk in enumerate(t):
        vol[:, k] = v
        if cond.treat_at_h is not None and cond.treat_at_h <= tk < cond.treat_at_h + dt_h:
            target = v + (target - v) * 0.3  # treatment limits how much more it grows
        v = v + (target - v) * (1 - np.exp(-rate * dt_h))
        if cond.surgery_at_h is not None and cond.surgery_at_h <= tk < cond.surgery_at_h + dt_h:
            v = v * 0.15
            target = v * 1.05
    return t, vol


def midline_shift_mm(volume_ml: np.ndarray) -> np.ndarray:
    return np.clip(np.asarray(volume_ml) * MLS_MM_PER_ML, 0, 25)


def lucid_z(volume_ml: np.ndarray, kind: str, spot: Spot | str, coil: CoilModel = CoilModel(), medium=HUMAN) -> np.ndarray:
    """What the probe would read for a bleed of each volume: the pair difference over its standard error."""
    spot = Spot.parse(spot)
    dirs = np.array([spot.direction, spot.mirror.direction])
    out = []
    for v in np.atleast_1d(volume_ml):
        if v <= 0.5:
            out.append(0.0)
            continue
        bleed = Bleed(spot, float(v), "subdural" if kind == "balloon" else kind)
        ov = bleed.overlap(medium, dirs, coil.decay_mm)
        out.append((medium.sigma_bleed - medium.sigma_tissue) * (ov[0] - ov[1]) / PAIR_SE)
    return np.array(out)


def outlook(volume_ml: float, kind: str, spot: Spot | str, lanes=PRESETS, hours: float = 12.0,
            n: int = 300, seed: int = 0) -> dict:
    """Every lane's volume, midline shift and Lucid reading over time: the mean of the runs and a 10-90% band.
    Every lane uses the same random runs, so the lanes differ only by their conditions."""
    t = None
    result = []
    for cond in lanes:
        t, vol = simulate_growth(volume_ml, kind, cond, hours, n=n, seed=seed)
        p10, p90 = np.percentile(vol, [10, 90], axis=0)
        mean = vol.mean(axis=0)
        z = lucid_z(mean, kind, spot)
        mls = midline_shift_mm(vol)
        over = np.argmax(mean >= GUIDE_VOLUME_ML) if (mean >= GUIDE_VOLUME_ML).any() else None
        result.append({
            "name": cond.name, "conditions": cond.describe(),
            "volume": {"p10": p10, "mean": mean, "p90": p90},
            "mls": {"p10": np.percentile(mls, 10, axis=0), "mean": mls.mean(axis=0),
                    "p90": np.percentile(mls, 90, axis=0)},
            "z": z,
            "end_volume_ml": float(mean[-1]),
            "p_over_guide": float((vol[:, -1] >= GUIDE_VOLUME_ML).mean()),
            "first_over_guide_h": float(t[over]) if over is not None else None,
        })
    return {"t": t, "lanes": result}
