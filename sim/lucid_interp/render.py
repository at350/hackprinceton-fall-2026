"""Render where the bleed most likely is inside the head: a 3D view plus top, front and side projections.

Shading is the chance each voxel is blood. Projections show the most likely voxel along each line of sight."""
from __future__ import annotations

import numpy as np

from lucid_sim.anatomy import HEAD_RADIUS_MM

from .locate import Location

CLOUD_CMAP = "inferno_r"
SPOT_CMAP = "coolwarm"


def _project(loc: Location, axes: tuple[int, int], step: float):
    """Maximum chance of blood along the third axis, on a 2D grid."""
    edges = np.arange(-HEAD_RADIUS_MM, HEAD_RADIUS_MM + step, step)
    ia = np.clip(np.digitize(loc.voxels[:, axes[0]], edges) - 1, 0, len(edges) - 2)
    ib = np.clip(np.digitize(loc.voxels[:, axes[1]], edges) - 1, 0, len(edges) - 2)
    img = np.zeros((len(edges) - 1, len(edges) - 1))
    np.maximum.at(img, (ib, ia), loc.blood)
    return img, edges


def _spot_colors(loc: Location):
    import matplotlib.pyplot as plt
    from matplotlib.colors import TwoSlopeNorm

    z = loc.spots["z_score"].fillna(0).to_numpy()
    lim = max(3.0, float(np.abs(z).max()))
    return plt.get_cmap(SPOT_CMAP)(TwoSlopeNorm(0, -lim, lim)(z))


def render_head(loc: Location, path=None, title: str | None = None, truth: np.ndarray | None = None):
    """`truth`: optional (3,) point to mark, e.g. the simulated bleed's near edge."""
    import matplotlib

    if path is not None:
        matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig = plt.figure(figsize=(13, 8.5), constrained_layout=True)
    grid = fig.add_gridspec(2, 3, width_ratios=[1.6, 1, 1])
    R = HEAD_RADIUS_MM
    cloud = loc.blood >= 0.1
    p = loc.blood[cloud]
    spot_colors = _spot_colors(loc)

    ax = fig.add_subplot(grid[:, 0], projection="3d")
    u, v = np.mgrid[0:2 * np.pi:36j, 0:np.pi:18j]
    ax.plot_wireframe(R * np.cos(u) * np.sin(v), R * np.sin(u) * np.sin(v), R * np.cos(v),
                      color="#9ca3af", linewidth=0.3, alpha=0.4)
    if cloud.any():
        colors = plt.get_cmap(CLOUD_CMAP)(0.2 + 0.8 * p)
        colors[:, 3] = 0.1 + 0.8 * p
        order = np.argsort(p)
        pts = loc.voxels[cloud][order]
        ax.scatter(pts[:, 0], pts[:, 1], pts[:, 2], c=colors[order], s=8 + 40 * p[order],
                   depthshade=False, edgecolors="none")
    ax.scatter(loc.spots["x"], loc.spots["y"], loc.spots["z"], c=spot_colors, s=90, edgecolors="black",
               depthshade=False)
    for _, s in loc.spots.iterrows():
        ax.text(s["x"] * 1.12, s["y"] * 1.12, s["z"] * 1.12, s["spot"], fontsize=7)
    ax.scatter([0], [R * 1.08], [0], marker="^", s=120, color="#111827")  # nose
    ax.text(0, R * 1.2, 0, "nose", fontsize=8)
    if truth is not None:
        ax.scatter(*truth, marker="x", s=150, color="#16a34a", linewidths=3, depthshade=False)
    ax.set_xlim(-R, R), ax.set_ylim(-R, R), ax.set_zlim(-R, R)
    ax.set_box_aspect((1, 1, 1))
    ax.set_xlabel("x: left → right (mm)"), ax.set_ylabel("y: back → nose"), ax.set_zlabel("z: up")
    ax.view_init(elev=22, azim=-60)
    ax.set_title(title or "Where the bleed most likely is")

    step = float(np.diff(np.unique(loc.voxels[:, 0]))[:1].min()) if len(loc.voxels) > 1 else 5.0
    views = [((0, 1), "Top (axial)", "x: left → right", "y: back → nose"),
             ((0, 2), "Front (coronal)", "x: left → right", "z: up"),
             ((1, 2), "Side (sagittal)", "y: back → nose", "z: up")]
    for k, (axes, name, xl, yl) in enumerate(views):
        a2 = fig.add_subplot(grid[[0, 0, 1][k], [1, 2, 1][k]])
        img, edges = _project(loc, axes, step)
        img = np.ma.masked_less(img, 0.05)  # leave the unlikely part of the head blank
        im = a2.imshow(img, origin="lower", extent=(edges[0], edges[-1], edges[0], edges[-1]), cmap=CLOUD_CMAP,
                       interpolation="bilinear", vmin=0, vmax=1)
        a2.add_patch(plt.Circle((0, 0), R, fill=False, color="#6b7280", lw=1))
        a2.scatter(loc.spots["xyz"[axes[0]]], loc.spots["xyz"[axes[1]]],
                   c=spot_colors, s=40, edgecolors="black", zorder=3)
        if truth is not None:
            a2.scatter(truth[axes[0]], truth[axes[1]], marker="x", s=80, color="#16a34a", linewidths=2.5, zorder=4)
        a2.set_title(name, fontsize=10)
        a2.set_xlabel(xl, fontsize=8), a2.set_ylabel(yl, fontsize=8)
        a2.set_xlim(-R * 1.1, R * 1.1), a2.set_ylim(-R * 1.1, R * 1.1)
        a2.set_aspect("equal")
        a2.tick_params(labelsize=7)

    text_ax = fig.add_subplot(grid[1, 2])
    text_ax.axis("off")
    s = loc.summary
    lines = [s["text"]]
    if "cloud_ml" in s:
        lines += ["", "Shading: chance each voxel is blood (dark = likely). It blurs in depth: 5 surface "
                      "pairs can't separate a deep small bleed from a shallow thin one.",
                  "Spots: red reads higher than its mirror spot, blue lower."]
    if truth is not None:
        lines.append("Green x: true near edge (simulation).")
    import textwrap

    fig.colorbar(im, cax=text_ax.inset_axes([0.0, 0.02, 0.9, 0.05]), orientation="horizontal",
                 label="chance of blood")
    text_ax.text(0, 1, "\n".join(textwrap.fill(l, 42) if l else "" for l in lines), va="top", fontsize=9)
    if path is not None:
        fig.savefig(path, dpi=130)
        plt.close(fig)
    return fig
