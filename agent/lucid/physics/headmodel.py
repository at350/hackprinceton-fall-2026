"""Forward model: what the device would read on a head with a given bleed.

A fast 2D proxy model, built for speed so hundreds of hypotheses fit in seconds:

* Coil channel. We solve the quasi-static conduction problem with pyEIT's FEM on a coarse
  2D elliptical head mesh with layered conductivities. 16 point electrodes sit evenly on
  the scalp (every 22.5 deg). For spot i we inject a unit current through the electrode
  pair around it (spot angle -/+ 22.5 deg) and read the voltage across the same pair: the
  local transfer impedance Z_i. Neighbouring spots share an electrode, and sensitivity is
  highest near the electrodes, so a bleed midway between two spots shows on both.
  The coil signal is healthy level + GAIN * 20*log10(Z_i/Z0_i), with ONE global gain fixed
  so the reference case (epidural, L temporal, 22 mL) reads -4.4 dB at the L temporal spot.
  Using the ratio to the healthy head removes the per-spot geometry (electrode spacing
  differs around the ellipse). A real device uses an induction coil, not electrodes; the
  impedance change stands in for it.
* NIR channel. Simple diffuse-optics proxy: healthy level minus K * (blood area weighted by
  exp(-d/DELTA), d = distance from the spot on the scalp). One global K fixed on the same
  reference case (-0.07). Light does not reach deep bleeds, so intraparenchymal bleeds
  barely move NIR while epidural/subdural ones do; that is what separates the types.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import numpy as np
import pyeit.eit.protocol as eit_protocol
import pyeit.mesh as eit_mesh
from pyeit.eit.fem import EITForward
from pyeit.mesh import shape as eit_shape

from .geometry import HEAD_RX, HEAD_RY, N_SPOTS, REGION_ANGLE, bleed_shape, point_at, polar

MESH_PATH = Path(__file__).resolve().parents[2] / "data" / "head_mesh.npz"

COIL_HEALTHY_DB = -38.2
NIR_HEALTHY = 0.612
REFERENCE = ("epidural", "L temporal", 22.0)  # calibration case
REF_SPOT = 6  # L temporal
REF_COIL_DROP_DB = 4.4
REF_NIR_DROP = 0.07

# Conductivities in S/m (approximate low-frequency literature values).
SIGMA = {"scalp": 0.43, "skull": 0.015, "csf": 1.79, "brain": 0.33, "blood": 0.7}
# Layer boundaries in normalised radius (r = 1 is the scalp surface): scalp, skull, CSF, brain.
# Blood replaces BRAIN tissue only (r <= R_CSF_IN); the thin CSF film is left as is. Blood
# is ~2x as conductive as brain, so every bleed type lowers the local impedance (one sign,
# monotone in volume). Letting blood also replace CSF would mix signs in this 2D proxy.
R_SKULL_OUT, R_SKULL_IN, R_CSF_IN = 0.97, 0.94, 0.92

MESH_H0 = 0.025  # edge length in the outer shell; the interior is 2.6x coarser (~2.9k triangles)
MESH_COARSEN = 2.6
N_EL = 16
BLEED_LEVEL = 0.5  # bleedShape value above which tissue counts as blood
NIR_DELTA = 0.07  # optical penetration length in map units

# 6 sample points per triangle (barycentric), used to assign partly covered elements a
# blood/tissue fraction. Keeps signals smooth in volume on a coarse mesh.
_BARY = np.array(
    [[4, 1, 1], [1, 4, 1], [1, 1, 4], [1, 2.5, 2.5], [2.5, 1, 2.5], [2.5, 2.5, 1]]
) / 6.0


def _mesh_size(p: np.ndarray) -> np.ndarray:
    """Relative edge length: 1 in the layered shell, growing to MESH_COARSEN in deep brain."""
    r, _ = polar(p[:, 0], p[:, 1])
    return 1.0 + (MESH_COARSEN - 1.0) * np.clip((0.86 - r) / 0.25, 0.0, 1.0)


def build_mesh() -> tuple[np.ndarray, np.ndarray]:
    """(nodes[n, 2], triangles[m, 3]) from pyEIT's distmesh; the first 16 nodes are electrodes.
    Electrode k sits at angle 22.5*k deg, so spot i uses electrodes 2i-1 and 2i+1."""
    ex, ey = point_at(22.5 * np.arange(N_EL))
    state = np.random.get_state()
    np.random.seed(0)  # distmesh draws its initial points from the global RNG
    try:
        mesh = eit_mesh.create(
            N_EL,
            fd=lambda p: eit_shape.ellipse(p, ab=[HEAD_RX, HEAD_RY]),
            fh=_mesh_size,
            h0=MESH_H0,
            p_fix=np.column_stack([ex, ey]),
            bbox=np.array([[-1.0, -1.0], [1.0, 1.0]]),
        )
    finally:
        np.random.set_state(state)
    return mesh.node[:, :2].copy(), mesh.element.copy()


def load_mesh() -> tuple[np.ndarray, np.ndarray]:
    """Mesh from data/head_mesh.npz (written by precompute, ~1 s saved and guarantees the
    live solve uses the exact mesh the table was computed on); rebuilt if the file is missing."""
    try:
        with np.load(MESH_PATH) as f:
            return f["node"], f["element"]
    except (OSError, KeyError, ValueError):
        return build_mesh()


class HeadModel:
    """Mesh, healthy conductivities and healthy solution. Built once (see `model()`)."""

    def __init__(self, nodes: np.ndarray | None = None, tri: np.ndarray | None = None) -> None:
        if nodes is None or tri is None:
            nodes, tri = load_mesh()
        mesh = eit_mesh.PyEITMesh(node=nodes, element=tri, el_pos=np.arange(N_EL), ref_node=N_EL)
        self.mesh = mesh
        self.fwd = EITForward(mesh, eit_protocol.create(N_EL, dist_exc=1, step_meas=1))
        nodes, tri = mesh.node[:, :2], mesh.element
        # Sample points inside every element: (n_elem, n_samples).
        self.sx = _BARY @ nodes[tri, 0].T
        self.sy = _BARY @ nodes[tri, 1].T
        self.sx, self.sy = self.sx.T, self.sy.T
        self.r, _ = polar(self.sx, self.sy)
        v = nodes[tri]
        self.area = 0.5 * np.abs(
            (v[:, 1, 0] - v[:, 0, 0]) * (v[:, 2, 1] - v[:, 0, 1])
            - (v[:, 2, 0] - v[:, 0, 0]) * (v[:, 1, 1] - v[:, 0, 1])
        )
        layer = np.where(
            self.r > R_SKULL_OUT,
            SIGMA["scalp"],
            np.where(self.r > R_SKULL_IN, SIGMA["skull"], np.where(self.r > R_CSF_IN, SIGMA["csf"], SIGMA["brain"])),
        )
        self.sigma_pts = layer  # healthy conductivity at every sample point
        # NIR kernel per (spot, element): exp(-distance from the spot on the scalp / delta).
        cx, cy = self.sx.mean(axis=1), self.sy.mean(axis=1)
        px, py = point_at(45.0 * np.arange(N_SPOTS))
        d = np.hypot(cx[None, :] - px[:, None], cy[None, :] - py[:, None])
        self.nir_kernel = np.exp(-d / NIR_DELTA) * self.area[None, :]
        self.z0 = self.impedance(layer.mean(axis=1))

    def blood_mask(self, type: str, angle: float, volume_ml: float) -> np.ndarray:
        """Boolean (n_elem, n_samples): sample points that are blood."""
        return (bleed_shape(type, angle, volume_ml)(self.sx, self.sy) > BLEED_LEVEL) & (self.r <= R_CSF_IN)

    def impedance(self, sigma_elem: np.ndarray) -> np.ndarray:
        """Transfer impedance at each of the 8 spots (pyEIT FEM solve, unit current)."""
        self.fwd.assemble_pde(sigma_elem)
        z = np.empty(N_SPOTS)
        for i in range(N_SPOTS):
            pair = np.array([(2 * i - 1) % N_EL, (2 * i + 1) % N_EL])
            u = self.fwd.solve(pair)[self.mesh.el_pos]
            z[i] = u[pair[0]] - u[pair[1]]
        return z

    def potentials(self, sigma_elem: np.ndarray) -> np.ndarray:
        """Node potentials for each spot's injection: (8, n_nodes), unit current."""
        self.fwd.assemble_pde(sigma_elem)
        return np.array([self.fwd.solve(np.array([(2 * i - 1) % N_EL, (2 * i + 1) % N_EL])) for i in range(N_SPOTS)])

    def raw(self, type: str, angle: float, volume_ml: float) -> tuple[np.ndarray, np.ndarray]:
        """Uncalibrated signals: (20*log10(Z/Z0) per spot, NIR blood integral per spot)."""
        blood = self.blood_mask(type, angle, volume_ml)
        sigma = np.where(blood, SIGMA["blood"], self.sigma_pts).mean(axis=1)
        z_db = 20.0 * np.log10(self.impedance(sigma) / self.z0)
        return z_db, self.nir_kernel @ blood.mean(axis=1)


@lru_cache(maxsize=1)
def model() -> HeadModel:
    return HeadModel()


@lru_cache(maxsize=1)
def _gains() -> tuple[float, float]:
    """The two global calibration constants, from the reference case."""
    type, region, vol = REFERENCE
    z_db, nir = model().raw(type, REGION_ANGLE[region], vol)
    return -REF_COIL_DROP_DB / z_db[REF_SPOT], REF_NIR_DROP / nir[REF_SPOT]


def forward_at(type: str, angle: float, volume_ml: float) -> dict:
    """Like `forward` but for a bleed at an arbitrary angle (used by the sample scans)."""
    g_coil, k_nir = _gains()
    z_db, nir = model().raw(type, angle, volume_ml)
    return {
        "coil_db": (COIL_HEALTHY_DB + g_coil * z_db).tolist(),
        "nir": (NIR_HEALTHY - k_nir * nir).tolist(),
    }


def forward(type: str, region: str, volume_ml: float) -> dict:
    """LIVE pyEIT solve. Returns {"coil_db": [8], "nir": [8]}: absolute, noise-free readings."""
    return forward_at(type, REGION_ANGLE[region], float(volume_ml))


def null_reading() -> dict:
    """Healthy head."""
    return {"coil_db": [COIL_HEALTHY_DB] * N_SPOTS, "nir": [NIR_HEALTHY] * N_SPOTS}


def mesh_geometry() -> dict:
    """The head mesh for drawing: nodes, triangles, the healthy tissue of every triangle,
    and which electrode pair each scan spot drives."""
    m = model()
    names = {v: k for k, v in SIGMA.items()}
    healthy = m.sigma_pts.mean(axis=1)
    # A triangle straddling two layers takes the layer of its centre sample.
    tissue = [names[float(v)] for v in m.sigma_pts[:, 3]]
    return {
        "nodes": np.round(m.mesh.node[:, :2], 4).tolist(),
        "triangles": m.mesh.element.tolist(),
        "tissue": tissue,
        "sigma": np.round(healthy, 4).tolist(),
        "conductivity": SIGMA,
        "electrodes": list(range(N_EL)),
        "spot_pairs": [[(2 * i - 1) % N_EL, (2 * i + 1) % N_EL] for i in range(N_SPOTS)],
    }


@lru_cache(maxsize=1)
def _healthy_potentials() -> np.ndarray:
    m = model()
    return m.potentials(m.sigma_pts.mean(axis=1))


def field(type: str, region: str, volume_ml: float) -> dict:
    """What the solver computes for one hypothesis, for the dashboard's detail view.

    blood: fraction of each triangle that is blood (0-1).
    sigma: conductivity of each triangle with the bleed in place.
    change: per spot, how much the bleed shifts the potential at every node compared
        with the healthy head, scaled to -1..1 over all 8 spots. This is the disturbance
        the device picks up.
    """
    m = model()
    blood = m.blood_mask(type, REGION_ANGLE[region], float(volume_ml))
    sigma = np.where(blood, SIGMA["blood"], m.sigma_pts).mean(axis=1)
    du = m.potentials(sigma) - _healthy_potentials()
    scale = float(np.abs(du).max()) or 1.0
    z = np.array([du[i, a] - du[i, b] for i, (a, b) in enumerate(mesh_geometry()["spot_pairs"])])
    return {
        "blood": np.round(blood.mean(axis=1), 3).tolist(),
        "sigma": np.round(sigma, 4).tolist(),
        "change": np.round(du / scale, 3).tolist(),
        "change_scale_v": scale,
        "impedance_change_pct": np.round(100 * z / m.z0, 3).tolist(),
    }
