"""Find when the probe is on the head, and which samples in each contact are clean."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from lucid_sim.channels import CoilModel


@dataclass
class Contact:
    start: int  # first sample index
    end: int  # one past the last sample
    spot: str | None = None
    good: np.ndarray | None = None  # per sample in [start, end)
    edge: np.ndarray | None = None  # settling at the start and lifting at the end
    rejected: dict = field(default_factory=dict)  # samples rejected per reason

    @property
    def slice(self) -> slice:
        return slice(self.start, self.end)


def sample_rate(units: pd.DataFrame) -> float:
    return 1000.0 / float(np.median(np.diff(units["t_ms"])))


def air_gain_db(coil: CoilModel, freq_hz) -> np.ndarray:
    """Coil reading in air at each frequency, relative to the reading at resonance."""
    return coil.dbm(freq_hz, 0.0, np.inf) - coil.drive_dbm


def coil_loss(units: pd.DataFrame, coil: CoilModel, fs: float, window_s: float = 20.0,
              air_band_db: float = 0.25) -> tuple[np.ndarray, np.ndarray]:
    """Coil loss in dB against the probe in air at the same frequency, with gain drift removed.

    Tissue only ever lowers the reading, so the top of a rolling window is the probe in air.
    The air level is tracked through time, so drift between spots cancels.
    Returns (loss_db, in_air).
    """
    norm = units["coil_dbm"].to_numpy() - air_gain_db(coil, units["freq_hz"].to_numpy())
    top = pd.Series(norm).rolling(max(3, int(window_s * fs)), center=True, min_periods=1).max().to_numpy()
    in_air = norm > top - air_band_db

    def air_level(mask):
        # Smooth over the air samples only, then draw straight lines across each contact.
        idx = np.flatnonzero(mask)
        smooth = pd.Series(norm[idx]).rolling(max(3, int(fs)), center=True, min_periods=1).median().to_numpy()
        return np.interp(np.arange(len(norm)), idx, smooth)

    # The first pass also catches the probe hovering a few mm off the head, which drags the
    # level down. Keep only samples within the noise of the air level and recompute.
    level = air_level(in_air)
    noise = 1.4826 * np.median(np.abs(norm[in_air] - level[in_air]))
    in_air = np.abs(norm - level) < max(4 * noise, 0.03)
    return norm - air_level(in_air), in_air


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    padded = np.concatenate([[0], mask.astype(np.int8), [0]])
    edges = np.flatnonzero(np.diff(padded))
    return list(zip(edges[::2], edges[1::2]))


def find_contacts(loss_db: np.ndarray, fs: float, threshold_db: float = -0.4, min_s: float = 1.0,
                  merge_gap_s: float = 1.0) -> list[Contact]:
    """Stretches where the coil is loaded by tissue. Brief lifts inside one hold are merged back in."""
    on = pd.Series(loss_db < threshold_db).rolling(5, center=True, min_periods=1).median().to_numpy() > 0.5
    runs = _runs(on)
    merged: list[list[int]] = []
    for start, end in runs:
        if merged and start - merged[-1][1] < merge_gap_s * fs:
            merged[-1][1] = end
        else:
            merged.append([start, end])
    return [Contact(s, e) for s, e in merged if e - s >= min_s * fs]


def _dilate(mask: np.ndarray, pad: int) -> np.ndarray:
    if pad <= 0 or not mask.any():
        return mask
    return np.convolve(mask.astype(int), np.ones(2 * pad + 1), mode="same") > 0


def mark_clean(units: pd.DataFrame, loss_db: np.ndarray, contact: Contact, fs: float, gyro_bias: np.ndarray,
               settle_s: float = 0.3, tail_s: float = 0.2, gyro_dps: float = 6.0, accel_g: float = 0.04,
               coil_mads: float = 5.0, coil_floor_db: float = 0.06, light_v: float = 0.03,
               pad_s: float = 0.15) -> None:
    """Fill contact.good, contact.edge and contact.rejected from motion, coil jumps and light leaks."""
    sl = contact.slice
    n = contact.end - contact.start
    edge = np.zeros(n, bool)
    edge[: int(settle_s * fs)] = True
    edge[n - int(tail_s * fs):] = True

    gyro = units[["gx_dps", "gy_dps", "gz_dps"]].to_numpy()[sl] - gyro_bias
    accel = units[["ax_g", "ay_g", "az_g"]].iloc[sl]
    jolt = accel - accel.rolling(max(3, int(0.5 * fs)), center=True, min_periods=1).median()
    coil = loss_db[sl]
    centre = np.median(coil[~edge]) if (~edge).any() else np.median(coil)
    mad = 1.4826 * np.median(np.abs(coil[~edge] - centre)) if (~edge).any() else 0.0
    light = units["ir_amb_v"].iloc[sl].rolling(max(3, int(0.2 * fs)), center=True, min_periods=1).mean().to_numpy()
    light_ref = np.median(light[~edge]) if (~edge).any() else np.median(light)

    checks = {
        "motion": np.linalg.norm(gyro, axis=1) > gyro_dps,
        "jolt": np.linalg.norm(jolt.to_numpy(), axis=1) > accel_g,
        "coil jump": np.abs(coil - centre) > max(coil_mads * mad, coil_floor_db),
        "light leak": light - light_ref > max(light_v, 0.25 * light_ref),
    }
    bad = np.zeros(n, bool)
    pad = int(pad_s * fs)
    for name, mask in checks.items():
        mask = _dilate(mask, pad)
        contact.rejected[name] = int((mask & ~edge).sum())
        bad |= mask
    contact.edge = edge
    contact.good = ~bad & ~edge
