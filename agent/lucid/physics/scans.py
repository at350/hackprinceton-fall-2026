"""Scans: fit score, likelihood maps reconstructed from a scan, and the deterministic mock scans."""
from __future__ import annotations

import numpy as np

from .headmodel import COIL_HEALTHY_DB, NIR_HEALTHY, REF_COIL_DROP_DB, REF_NIR_DROP, forward_at, null_reading
from .geometry import N_SPOTS, R_CLIP, SPOT_NAMES, background, grid_axes, polar, spot_sensitivity

# ---- Fit --------------------------------------------------------------------
# Error model per value: sigma^2 = floor^2 + (REL * anomaly)^2, where anomaly is the mean
# of the scan's and the simulation's deviation from the healthy head at that spot.
# The floor is sensor noise; the relative term is model/coupling error, which grows with the
# signal. Without it a 5 mL deep bleed on a clear scan (tiny absolute residual) and a wrong
# bleed type on a big bleed (large absolute residual) cannot both be scored sensibly.
SIGMA_COIL_DB = 0.15
SIGMA_NIR = 0.004
SIGMA_REL = 0.30
WEAK_WEIGHT = 0.3  # weight of a "weak"-quality spot relative to a good one
FIT_SCALE = 1.0  # score = exp(-mean_chi2 / (2 * FIT_SCALE))


def _arrays(reading: dict) -> tuple[np.ndarray, np.ndarray]:
    """(coil_db[8], nir[8]) from either a sim reading or a scan dict with "spots"."""
    if "spots" in reading:
        spots = sorted(reading["spots"], key=lambda s: s.get("index", 0))
        return np.array([s["coil_db"] for s in spots], float), np.array([s["nir"] for s in spots], float)
    return np.asarray(reading["coil_db"], float), np.asarray(reading["nir"], float)


def _weights(scan: dict) -> np.ndarray:
    spots = sorted(scan.get("spots", []), key=lambda s: s.get("index", 0))
    w = [WEAK_WEIGHT if s.get("quality") == "weak" else 1.0 for s in spots]
    return np.array(w or [1.0] * N_SPOTS)


def _patient_offset(baseline: dict | None) -> tuple[float, float]:
    """Per-patient offset (coil dB, NIR) estimated from an earlier scan of the same patient:
    the median over the 8 spots of (baseline - healthy model). The median ignores the few
    spots that sit over a bleed, so this only removes a whole-head shift (skin tone, hair,
    coupling), not the bleed itself."""
    if baseline is None:
        return 0.0, 0.0
    c, n = _arrays(baseline)
    return float(np.median(c) - COIL_HEALTHY_DB), float(np.median(n) - NIR_HEALTHY)


def fit(sim: dict, scan: dict, baseline: dict | None = None) -> float:
    """0-1 match between a simulated reading and a scan.

    score = exp(-chi2 / 2), chi2 = quality-weighted mean over the 16 values (8 coil + 8 NIR)
    of the squared noise-normalised residual. 1 = identical; monotone in the residual.
    """
    sim_c, sim_n = _arrays(sim)
    scan_c, scan_n = _arrays(scan)
    off_c, off_n = _patient_offset(baseline)
    scan_c, scan_n = scan_c - off_c, scan_n - off_n
    w = _weights(scan)

    def chi2(sim_v: np.ndarray, scan_v: np.ndarray, healthy: float, floor: float) -> np.ndarray:
        anomaly = (np.abs(sim_v - healthy) + np.abs(scan_v - healthy)) / 2
        return (sim_v - scan_v) ** 2 / (floor**2 + (SIGMA_REL * anomaly) ** 2)

    terms = chi2(sim_c, scan_c, COIL_HEALTHY_DB, SIGMA_COIL_DB) + chi2(sim_n, scan_n, NIR_HEALTHY, SIGMA_NIR)
    mean_chi2 = float((w * terms).sum() / (2 * w.sum()))
    return round(float(np.exp(-mean_chi2 / (2 * FIT_SCALE))), 4)


def residuals(sim: dict, scan: dict) -> dict:
    """Per spot, how far the simulation is from the scan in units of expected error
    (signed: negative = the simulation reads lower). Same error model as `fit`."""
    sim_c, sim_n = _arrays(sim)
    scan_c, scan_n = _arrays(scan)

    def z(sim_v: np.ndarray, scan_v: np.ndarray, healthy: float, floor: float) -> list[float]:
        anomaly = (np.abs(sim_v - healthy) + np.abs(scan_v - healthy)) / 2
        return np.round((sim_v - scan_v) / np.sqrt(floor**2 + (SIGMA_REL * anomaly) ** 2), 2).tolist()

    return {
        "coil": z(sim_c, scan_c, COIL_HEALTHY_DB, SIGMA_COIL_DB),
        "nir": z(sim_n, scan_n, NIR_HEALTHY, SIGMA_NIR),
        "weight": _weights(scan).tolist(),
    }


# ---- Likelihood map ---------------------------------------------------------
KERNEL_POWER = 6  # sharpens the broad mock.ts spot kernel (sigma 0.5 -> ~0.2) for localisation
PEAK_SENS = 0.85  # a point is "under" a spot when its mock.ts sensitivity exceeds this


def _spot_anomaly(scan: dict) -> np.ndarray:
    """Per spot 0-1: how bleed-like the reading is (coil drop or NIR drop vs healthy,
    each scaled by the drop of the 22 mL reference bleed; the larger of the two)."""
    c, n = _arrays(scan)
    a = np.maximum((COIL_HEALTHY_DB - c) / REF_COIL_DROP_DB, (NIR_HEALTHY - n) / REF_NIR_DROP)
    return np.clip(a, 0.0, 1.0)


def _likelihood(scan: dict, n: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    X, Y = grid_axes(n)
    r, _ = polar(X, Y)
    a = _spot_anomaly(scan)
    proj = sum(a[i] * spot_sensitivity(i, X, Y) ** KERNEL_POWER for i in range(N_SPOTS))
    v = np.clip(background(X, Y), 0.07, 0.15) + 0.9 * np.minimum(1.0, proj)
    return np.where(r > R_CLIP, 0.0, np.minimum(1.0, v)), X, Y


def likelihood_map(scan: dict, n: int = 64) -> list[list[float]]:
    """Bleed-likelihood map 0-1 from the 8 spot readings (back-projection, not a real
    inverse solve): low smooth background inside the head plus each spot's anomaly spread
    through its sensitivity kernel. Same grid convention as mock.ts scanMap."""
    return np.round(_likelihood(scan, n)[0], 2).tolist()


def spot_peaks(scan: dict) -> list[float]:
    """Peak likelihood under each spot, read off the same map as `likelihood_map`."""
    v, X, Y = _likelihood(scan, 64)
    return [round(float(v[spot_sensitivity(i, X, Y) > PEAK_SENS].max()), 2) for i in range(N_SPOTS)]


# ---- Mock scans -------------------------------------------------------------
MOCK_CASES = ("temporal_bleed", "clear", "uncertain")
NOISE_COIL_DB = 0.04  # per-spot reading noise after the device averages its stream
NOISE_NIR = 0.001

# case -> (bleed truth or None, noise multiplier, weak spots, seed)
_CASES: dict[tuple[str, bool], dict] = {
    # Epidural, L temporal (268 deg), 22 mL: off the 5 mL hypothesis grid on purpose.
    ("temporal_bleed", False): {"truth": ("epidural", 268.0, 22.0), "noise": 1.0, "weak": (), "seed": 11},
    # Same patient 15 min later, bleed grown to ~27 mL.
    ("temporal_bleed", True): {"truth": ("epidural", 268.0, 27.0), "noise": 1.0, "weak": (), "seed": 12},
    ("clear", False): {"truth": None, "noise": 1.0, "weak": (), "seed": 21},
    ("clear", True): {"truth": None, "noise": 1.0, "weak": (), "seed": 22},
    # Thin subdural over L parietal, read through poor contact at the two spots that matter.
    # Too noisy to call; re-seating those two spots (mock_scan(..., reseat=(5, 6))) resolves it.
    ("uncertain", False): {"truth": ("subdural", 222.0, 12.0), "noise": 4.0, "weak": (5, 6), "seed": 19},
    ("uncertain", True): {"truth": ("subdural", 222.0, 12.0), "noise": 4.0, "weak": (5, 6), "seed": 36},
}
WEAK_NOISE = 2.0  # extra noise multiplier on weak-quality spots


def mock_scan(case: str, rescan: bool = False, reseat: tuple[int, ...] = ()) -> dict:
    """Deterministic synthetic scan: forward model of the case's truth + fixed-seed noise.

    `reseat` lists spots the medic scanned again with the device pressed flat: those
    spots get good contact and normal noise; the others keep their first reading.
    """
    if case not in MOCK_CASES:
        raise ValueError(f"unknown mock case {case!r}; expected one of {MOCK_CASES}")
    cfg = _CASES[(case, rescan)]
    clean = forward_at(*cfg["truth"]) if cfg["truth"] else null_reading()
    rng = np.random.default_rng(cfg["seed"])
    scale = cfg["noise"] * np.where(np.isin(np.arange(N_SPOTS), cfg["weak"]), WEAK_NOISE, 1.0)
    coil = np.array(clean["coil_db"]) + rng.normal(0, NOISE_COIL_DB, N_SPOTS) * scale
    nir = np.array(clean["nir"]) + rng.normal(0, NOISE_NIR, N_SPOTS) * scale
    if reseat:
        again = np.random.default_rng(cfg["seed"] + 100)
        idx = np.array(sorted(set(reseat)))
        coil[idx] = np.array(clean["coil_db"])[idx] + again.normal(0, NOISE_COIL_DB, len(idx))
        nir[idx] = np.array(clean["nir"])[idx] + again.normal(0, NOISE_NIR, len(idx))
        cfg = {**cfg, "weak": tuple(i for i in cfg["weak"] if i not in reseat)}
    spots = [
        {
            "index": i,
            "name": SPOT_NAMES[i],
            "angle": i * 45,
            "coil_db": round(float(coil[i]), 2),
            "nir": round(float(nir[i]), 4),
            "quality": "weak" if i in cfg["weak"] else "good",
        }
        for i in range(N_SPOTS)
    ]
    return {"case": case, "taken_at": None, "spots": spots}
