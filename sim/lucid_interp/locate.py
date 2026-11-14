"""Where in the head is the bleed? A grid fit of a bleed model to the left/right conductivity differences.

Each candidate is a bleed at some point inside the head, with some lateral spread and some conductivity
contrast. The coil at each spot sees it through the same falloff the simulator uses:
    d_sigma(spot) = contrast * exp(-hypot(max(R * angle - spread, 0), depth) / decay)
Only left/right differences are fitted, since region-to-region differences in normal tissue are larger
than a bleed. Contrast is integrated out over [0, max_contrast], spread is summed over, and the result
is a probability per voxel: a cloud that is tight where the data pin the bleed down and wide where they don't.

A voxel stands for the bleed's point nearest the scalp, so the cloud marks where the bleed starts, not
how big it is. With 5 pairs, depth and size trade off against each other, so the cloud is honest about being blurry in
depth. The side and the region are what the data really fix.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from scipy.special import logsumexp

from lucid_sim.anatomy import HEAD_RADIUS_MM, REGIONS, Spot, direction

from .layers import Interpretation


@dataclass(frozen=True)
class BleedPrior:
    """What a bleed can look like. Human defaults; `PHANTOM_PRIOR` for the saline phantom."""

    max_contrast: float = 0.35  # S/m: blood minus tissue, the most a fully covered spot can rise
    outer_layer_mm: float = 12.0  # scalp + skull: no bleed shallower than this
    spreads_mm: tuple[float, ...] = (0.0, 15.0, 30.0)  # lateral radius of the bleed
    step_mm: float = 5.0  # voxel size
    n_contrast: int = 40
    credible: float = 0.9  # mass of the reported cloud
    thick_sat_mm: float = 10.0  # contrast = max_contrast * (1 - exp(-thickness / thick_sat)), as in the simulator
    max_thick_mm: float = 50.0
    n_shapes: int = 3000  # most likely bleed shapes kept when painting the blood map
    tissue_sigma: float = 0.25  # S/m, normal tissue, before any spot is read (live predictions)
    region_sd: float = 0.04  # S/m, how much one region differs from another in normal tissue


HUMAN_PRIOR = BleedPrior()
PHANTOM_PRIOR = BleedPrior(max_contrast=1.2, outer_layer_mm=4.0, tissue_sigma=0.3, region_sd=0.01)
PRIORS = {"human": HUMAN_PRIOR, "phantom": PHANTOM_PRIOR}


@dataclass
class Location:
    voxels: np.ndarray  # (N, 3) mm, head frame: +x right ear, +y nose, +z crown
    prob: np.ndarray  # (N,) posterior per voxel, sums to 1
    in_cloud: np.ndarray  # (N,) bool: the smallest set of voxels holding `credible` of the mass
    blood: np.ndarray  # (N,) chance each voxel is inside the bleed, from the fitted position, size and thickness
    summary: dict
    spots: pd.DataFrame  # per spot: direction and measured asymmetry, for drawing
    decay_mm: float = 15.0
    log_like: np.ndarray | None = field(default=None, repr=False)  # (voxel, spread x contrast), vs no bleed
    spreads_mm: tuple = ()
    contrast: np.ndarray | None = field(default=None, repr=False)

    def sample(self, n: int, rng: np.random.Generator):
        """Draw bleed shapes from the posterior: (near-edge points (n, 3), spreads (n,), contrasts (n,))."""
        if self.log_like is None:
            raise ValueError("no fit to sample from")
        post = np.exp(self.log_like - logsumexp(self.log_like)).ravel()
        k = rng.choice(post.size, size=n, p=post / post.sum())
        vox, j = np.divmod(k, self.log_like.shape[1])
        n_c = len(self.contrast)
        return self.voxels[vox], np.asarray(self.spreads_mm)[j // n_c], self.contrast[j % n_c]

    def cloud_records(self, max_points: int = 2000) -> list[dict]:
        """Voxels likely to be blood, plus the near-edge cloud, as plain records for a front end to draw.
        `blood`: chance the voxel is inside the bleed; `edge`: posterior that the bleed starts there."""
        idx = np.flatnonzero((self.blood >= 0.05) | self.in_cloud)
        idx = idx[np.argsort(-self.blood[idx])][:max_points]
        return [{"x": float(x), "y": float(y), "z": float(z), "blood": float(b), "edge": float(p)}
                for (x, y, z), b, p in zip(self.voxels[idx].round(1), self.blood[idx], self.prob[idx])]


def _grid(prior: BleedPrior) -> np.ndarray:
    r_max = HEAD_RADIUS_MM - prior.outer_layer_mm
    axis = np.arange(-r_max, r_max + 1e-9, prior.step_mm)
    x, y, z = np.meshgrid(axis, axis, axis, indexing="ij")
    pts = np.column_stack([x.ravel(), y.ravel(), z.ravel()])
    # Keep the cranium: inside the brain sphere and above the skull base.
    r = np.linalg.norm(pts, axis=1)
    return pts[(r <= r_max) & (pts[:, 2] >= -0.35 * HEAD_RADIUS_MM)]


def _sensitivity(pts: np.ndarray, dirs: np.ndarray, spread: float, decay_mm: float) -> np.ndarray:
    """(N voxels, M spots): how much of a spot's coil reading a bleed of unit contrast at each voxel fills."""
    r = np.linalg.norm(pts, axis=1)
    u = pts / np.maximum(r, 1e-9)[:, None]
    depth = HEAD_RADIUS_MM - r
    angle = np.arccos(np.clip(u @ dirs.T, -1.0, 1.0))
    lateral = np.maximum(HEAD_RADIUS_MM * angle - spread, 0.0)
    return np.exp(-np.hypot(lateral, depth[:, None]) / decay_mm)


def bleed_rise(points: np.ndarray, spreads: np.ndarray, contrast: np.ndarray, dirs: np.ndarray,
               decay_mm: float) -> np.ndarray:
    """(n bleeds, M spots): conductivity rise each bleed causes under each spot direction, S/m."""
    r = np.linalg.norm(points, axis=1)
    u = points / np.maximum(r, 1e-9)[:, None]
    angle = np.arccos(np.clip(u @ np.asarray(dirs).T, -1.0, 1.0))
    lateral = np.maximum(HEAD_RADIUS_MM * angle - np.asarray(spreads)[:, None], 0.0)
    return np.asarray(contrast)[:, None] * np.exp(-np.hypot(lateral, (HEAD_RADIUS_MM - r)[:, None]) / decay_mm)


def _blood_map(pts, log_like, spreads, contrast, prior: BleedPrior):
    """Paint each likely bleed shape (near edge, lateral radius, thickness) into the voxels, weighted by its
    posterior. Thickness follows from the fitted contrast. Returns (chance of blood per voxel, volume samples)."""
    n_c = len(contrast)
    post = np.exp(log_like - logsumexp(log_like)).ravel()
    top = np.argsort(-post)[:prior.n_shapes]
    top = top[np.cumsum(post[top]) <= 0.995 + post[top[0]]]
    weight = post[top] / post[top].sum()
    vox, k = np.divmod(top, log_like.shape[1])
    spread = np.asarray(spreads)[k // n_c]
    frac = np.minimum(contrast[k % n_c] / prior.max_contrast, 1 - 1e-9)
    thick = np.minimum(-prior.thick_sat_mm * np.log1p(-frac), prior.max_thick_mm)
    lateral = np.maximum(spread, thick / 2)  # a compact bleed is about as wide as it is thick

    r_all = np.linalg.norm(pts, axis=1)
    u_all = pts / np.maximum(r_all, 1e-9)[:, None]
    depth_all = HEAD_RADIUS_MM - r_all
    edge_depth = depth_all[vox]
    blood = np.zeros(len(pts))
    for i in range(0, len(top), 200):
        sl = slice(i, i + 200)
        ang = np.arccos(np.clip(u_all[vox[sl]] @ u_all.T, -1.0, 1.0)) * HEAD_RADIUS_MM  # (H, N) mm along the scalp
        d = depth_all[None, :] - edge_depth[sl, None]
        inside = (ang <= lateral[sl, None]) & (d >= -prior.step_mm / 2) & (d <= thick[sl, None])
        blood += weight[sl] @ inside
    volume_ml = np.pi * lateral**2 * thick / 1000
    return np.minimum(blood, 1.0), volume_ml, weight


def _nearest_region(point: np.ndarray) -> tuple[str, str]:
    u = point / max(np.linalg.norm(point), 1e-9)
    best = max(((side, region) for side in "LR" for region in REGIONS),
               key=lambda sr: direction(sr[0], *REGIONS[sr[1]]) @ u)
    return best


def locate(interp: Interpretation, prior: BleedPrior = HUMAN_PRIOR, blood: bool = True) -> Location:
    return locate_pairs(interp.pairs, interp.calibration.coil.decay_mm, prior, blood)


def locate_pairs(pairs: pd.DataFrame, decay: float, prior: BleedPrior = HUMAN_PRIOR, blood: bool = True) -> Location:
    """Fit from a pairs table (as `Interpretation.pairs`); incomplete pairs are skipped.
    `blood=False` skips painting the blood map, which is most of the time, for live updates."""
    pairs = pairs[np.isfinite(pairs["z"].astype(float))] if len(pairs) else pairs
    pts = _grid(prior)

    spot_rows = []
    for region in REGIONS:
        row = pairs[pairs["region"] == region] if len(pairs) else pairs
        for side in "LR":
            d = Spot(side, region).direction
            measured = float(row["d_sigma"].iloc[0]) * (1 if side == "R" else -1) if len(row) else np.nan
            spot_rows.append({"spot": f"{side}-{region}", "side": side, "region": region,
                              "x": d[0] * HEAD_RADIUS_MM, "y": d[1] * HEAD_RADIUS_MM, "z": d[2] * HEAD_RADIUS_MM,
                              "asymmetry": measured,
                              "z_score": float(row["z"].iloc[0]) * (1 if side == "R" else -1) if len(row) else np.nan})
    spots = pd.DataFrame(spot_rows)

    if pairs.empty:
        prob = np.full(len(pts), 1 / len(pts))
        return Location(pts, prob, np.ones(len(pts), bool), np.zeros(len(pts)),
                        {"status": "no data", "bayes_factor": 1.0, "log10_bayes_factor": 0.0,
                         "text": "No complete left/right pair to locate from."}, spots, decay)

    y = pairs["d_sigma"].to_numpy()
    w = 1 / pairs["d_sigma_se"].to_numpy() ** 2
    dir_r = np.array([Spot("R", r).direction for r in pairs["region"]])
    dir_l = np.array([Spot("L", r).direction for r in pairs["region"]])
    contrast = np.linspace(0, prior.max_contrast, prior.n_contrast + 1)[1:]

    # Log likelihood relative to "no bleed", for every voxel, spread and contrast:
    # chi2(A) - chi2(0) = -2 A sum(w g y) + A^2 sum(w g^2).
    log_like = []
    for spread in prior.spreads_mm:
        g = _sensitivity(pts, dir_r, spread, decay) - _sensitivity(pts, dir_l, spread, decay)  # (N, P)
        gy, gg = g @ (w * y), (g**2) @ w
        log_like.append(np.outer(gy, contrast) - np.outer(gg, contrast**2) / 2)
    log_like = np.concatenate(log_like, axis=1)
    log_voxel = logsumexp(log_like, axis=1) - np.log(log_like.shape[1])  # averaged over spread and contrast

    log_bf = float(logsumexp(log_voxel) - np.log(len(pts)))  # bleed somewhere (uniform) vs no bleed
    bayes_factor = float(np.exp(min(log_bf, 700)))
    prob = np.exp(log_voxel - logsumexp(log_voxel))
    order = np.argsort(-prob)
    keep = np.cumsum(prob[order]) <= prior.credible
    keep[np.argmax(~keep) if not keep.all() else -1] = True  # include the voxel that crosses the line
    in_cloud = np.zeros(len(pts), bool)
    in_cloud[order[keep]] = True

    if blood:
        blood_map, volume_ml, vol_w = _blood_map(pts, log_like, prior.spreads_mm, contrast, prior)
    else:
        blood_map, volume_ml, vol_w = np.zeros(len(pts)), np.zeros(1), np.ones(1)
    vol_mean = float(vol_w @ volume_ml)

    centroid = (prob[:, None] * pts).sum(axis=0)
    peak = pts[order[0]]
    depth = HEAD_RADIUS_MM - np.linalg.norm(pts, axis=1)
    side, region = _nearest_region(peak)
    side_prob_r = float(prob[pts[:, 0] > 0].sum())
    summary = {
        "status": "localized" if bayes_factor >= 10 else "weak" if bayes_factor >= 1 else "none",
        "bayes_factor": bayes_factor,
        "log10_bayes_factor": log_bf / np.log(10),
        "peak_mm": peak.round(1).tolist(),
        "centroid_mm": centroid.round(1).tolist(),
        "side": side,
        "region": region,
        "p_right": side_prob_r,
        "depth_mm": float((prob * depth).sum()),
        "depth_sd_mm": float(np.sqrt((prob * (depth - (prob * depth).sum()) ** 2).sum())),
        "cloud_ml": float(in_cloud.sum() * prior.step_mm**3 / 1000),
        "credible": prior.credible,
        "volume_ml": vol_mean,
        "volume_sd_ml": float(np.sqrt(vol_w @ (volume_ml - vol_mean) ** 2)),
        "blood_ml": float(blood_map.sum() * prior.step_mm**3 / 1000),
    }
    side_name = {"L": "left", "R": "right"}[side]
    if summary["status"] == "none":
        summary["text"] = "No bleed-like pattern: the left/right differences fit a healthy head better."
    else:
        summary["text"] = (f"Most likely {side_name} {region}, about {summary['depth_mm']:.0f} ± "
                           f"{summary['depth_sd_mm']:.0f} mm deep ({100 * max(side_prob_r, 1 - side_prob_r):.0f}% "
                           f"on that side){f', roughly {vol_mean:.0f} ml' if blood else ''}. {'Weak' if summary['status'] == 'weak' else 'Strong'} evidence "
                           f"(Bayes factor {bayes_factor:.3g}). Screening estimate, not imaging.")
    return Location(pts, prob, in_cloud, blood_map, summary, spots, decay, log_like, tuple(prior.spreads_mm), contrast)
