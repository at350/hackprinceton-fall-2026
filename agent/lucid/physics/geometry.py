"""2D head geometry and bleed shapes: a line-by-line mirror of the front end's lib/mock.ts.

Axial view from above, nose up. Map coordinates x, y in [-1, 1]; y = -1 is the nose.
Angles in degrees: 0 = nose, clockwise seen from above (90 = patient's right).
Everything here is vectorised over numpy arrays so it can be evaluated on grids and meshes.
"""
from __future__ import annotations

from typing import Callable

import numpy as np

HEAD_RX, HEAD_RY = 0.676, 0.92  # mock.ts HEAD
R_CLIP = 0.97  # nothing is drawn outside this normalised radius

BLEED_TYPES = ("epidural", "subdural", "intraparenchymal")
REGION_ANGLE: dict[str, float] = {
    "L frontal": 325,
    "R frontal": 35,
    "L temporal": 268,
    "R temporal": 92,
    "L parietal": 222,
    "R parietal": 138,
    "L occipital": 192,
    "R occipital": 168,
}
LOBES = ("frontal", "temporal", "parietal", "occipital")
VOLUMES = (5, 10, 15, 20, 25, 30, 35, 40)
SPOT_NAMES = [
    "Frontal",
    "R frontal",
    "R temporal",
    "R parietal",
    "Occipital",
    "L parietal",
    "L temporal",
    "L frontal",
]
N_SPOTS = 8

Shape = Callable[[np.ndarray, np.ndarray], np.ndarray]


def polar(x, y) -> tuple[np.ndarray, np.ndarray]:
    """(r, a): normalised elliptical radius and angle in degrees (0 = nose, clockwise)."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    r = np.hypot(x / HEAD_RX, y / HEAD_RY)
    a = np.degrees(np.arctan2(x, -y)) % 360.0
    return r, a


def point_at(angle_deg, r: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
    a = np.radians(angle_deg)
    return np.sin(a) * HEAD_RX * r, -np.cos(a) * HEAD_RY * r


def ang_diff(a, b) -> np.ndarray:
    """Absolute angular distance in radians."""
    d = np.abs(np.asarray(a, float) - b) % 360.0
    return np.radians(np.where(d > 180.0, 360.0 - d, d))


def grid_axes(n: int) -> tuple[np.ndarray, np.ndarray]:
    """X, Y arrays of shape (n, n); row index = y, column index = x (mock.ts `grid`)."""
    lin = np.linspace(-1.0, 1.0, n)
    return np.meshgrid(lin, lin)  # X[row, col] = lin[col], Y[row, col] = lin[row]


def bleed_shape(type: str, angle: float, volume: float) -> Shape:
    """Bleed shape for a hypothesis, 0-1, evaluated at (x, y). Mirror of mock.ts bleedShape."""
    s = float(np.cbrt(volume / 20.0))
    if type not in BLEED_TYPES:
        raise ValueError(f"unknown bleed type {type!r}")

    def shape(x, y) -> np.ndarray:
        x, y = np.asarray(x, float), np.asarray(y, float)
        r, a = polar(x, y)
        da = ang_diff(a, angle)
        if type == "epidural":  # lens hugging the inner skull, short arc
            dr = (0.86 - r) / (0.09 * s)
            dt = da / (0.32 * s)
            v = np.exp(-(dr * dr + dt * dt) / 2)
        elif type == "subdural":  # thin crescent along the skull, long arc
            dr = (0.9 - r) / (0.045 * s)
            dt = da / (0.62 * s)
            v = np.exp(-(dr * dr + dt**4) / 2)
        else:  # intraparenchymal: round blob at mid depth
            cx, cy = point_at(angle, 0.5)
            d = np.hypot(x - cx, y - cy) / (0.14 * s)
            v = np.exp(-(d * d) / 2)
        return np.where(r > R_CLIP, 0.0, v)

    return shape


def background(x, y) -> np.ndarray:
    """Smooth, low background 'likelihood' (mock.ts background) so scanned tissue isn't flat."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    v = (
        np.sin(x * 5.1 + 1.3) * np.cos(y * 4.3 - 0.7)
        + 0.6 * np.sin((x + y) * 7.7 + 2.1)
        + 0.4 * np.cos(x * 11.3 - y * 3.1)
    )
    return 0.09 + 0.05 * v


def spot_sensitivity(spot: int, x, y) -> np.ndarray:
    """Sensitivity of one scan spot at (x, y): strongest under the coil (mock.ts spotSensitivity)."""
    px, py = point_at(spot * 45.0)
    d2 = (np.asarray(x, float) - px) ** 2 + (np.asarray(y, float) - py) ** 2
    return np.exp(-d2 / (2 * 0.5 * 0.5))


def hypothesis_map(type: str, region: str, volume_ml: float, n: int = 32) -> list[list[float]]:
    """Mirror of mock.ts simMap: 0.06 floor inside the head + 0.92 * bleed shape, 0 outside."""
    X, Y = grid_axes(n)
    r, _ = polar(X, Y)
    v = np.minimum(1.0, 0.06 + 0.92 * bleed_shape(type, REGION_ANGLE[region], volume_ml)(X, Y))
    return np.round(np.where(r > R_CLIP, 0.0, v), 2).tolist()
