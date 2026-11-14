"""Quick-look plot of an interpretation: layers per pair and the Fourier split of one spot."""
from __future__ import annotations

import numpy as np

from .layers import Interpretation

SIDE_COLORS = {"L": "#3b82f6", "R": "#f97316"}
COMPONENT_COLORS = {"drift": "#6b7280", "pulse": "#dc2626", "tremor": "#16a34a", "flicker": "#ca8a04",
                    "noise": "#9ca3af"}


def _pick_spot(interp: Interpretation) -> str | None:
    flag = interp.flag
    if flag.get("regions"):
        return f"{flag['side']}-{flag['regions'][0]}"
    ok = interp.spots[interp.spots["status"] == "ok"]
    return ok["spot"].iloc[0] if len(ok) else None


def interpretation_figure(interp: Interpretation, path=None, spot: str | None = None):
    import matplotlib

    if path is not None:
        matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    spot = spot or _pick_spot(interp)
    pairs = interp.pairs
    fig = plt.figure(figsize=(13, 10), constrained_layout=True)
    grid = fig.add_gridspec(4, 3)

    # Layers per pair: gap, conductivity, and the left/right test.
    y = np.arange(len(pairs))
    h = 0.38
    for col, (key, label) in enumerate([("gap_{}_mm", "gap: hair + air (mm)"), ("sigma_{}", "tissue conductivity (S/m)")]):
        ax = fig.add_subplot(grid[0:2, col])
        for k, side in enumerate("LR"):
            err = pairs.get(f"sigma_{side}_se") if key.startswith("sigma") else None
            ax.barh(y + (k - 0.5) * h, pairs[key.format(side)], h, xerr=err, color=SIDE_COLORS[side], label=side,
                    error_kw={"lw": 0.8})
        ax.set_yticks(y, pairs["region"])
        ax.invert_yaxis()
        ax.set_title(label, fontsize=10)
        ax.legend(fontsize=8, loc="lower right")
    ax = fig.add_subplot(grid[0:2, 2])
    z = pairs["z"].fillna(0)
    ax.barh(y, z, color=[SIDE_COLORS["R"] if v > 0 else SIDE_COLORS["L"] for v in z])
    thr = interp.calibration.flag_z
    for v in (-thr, thr):
        ax.axvline(v, color="k", ls="--", lw=0.8)
    ax.axvline(0, color="k", lw=0.6)
    ax.set_yticks(y, pairs["region"])
    ax.invert_yaxis()
    ax.set_title("R - L conductivity (z)\n← left higher   right higher →", fontsize=10)

    # Fourier split of one spot, rebuilt from each band with an inverse FFT.
    if spot is not None:
        for row, (channel, label) in enumerate([("ir_net_v", "IR, LED on - off (V)"), ("coil_loss_db", "coil loss (dB)")]):
            d = interp.decomposition(spot, channel)
            t = d.t_s
            ax = fig.add_subplot(grid[2 + row, 0:2])
            ax.plot(t, d.signal, color="k", lw=0.8, label="signal")
            ax.plot(t, d.trend, color="#6b7280", lw=1, ls="--", label=f"trend ({d.slope_per_s:+.3g}/s)")
            ax.set_ylabel(label)
            ax.set_title(f"{spot}: {label}", fontsize=10)
            ax.legend(fontsize=8, loc="upper right")
            comp_ax = fig.add_subplot(grid[2 + row, 2])
            offset = 0.0
            spread = max(np.ptp(v) for v in d.components.values()) or 1.0
            for name, series in d.components.items():
                comp_ax.plot(t, series + offset, lw=0.7, color=COMPONENT_COLORS.get(name, "k"))
                extra = f", {d.peak_hz[name]:.2f} Hz" if name in d.peak_hz and name != "drift" else ""
                comp_ax.text(t[-1], offset, f" {name}\n rms {d.rms[name]:.2g}{extra}", fontsize=7, va="center")
                offset -= spread
            comp_ax.set_yticks([])
            comp_ax.set_xlabel("s")
            comp_ax.set_title("components (inverse FFT per band)", fontsize=10)

    fig.suptitle(interp.flag["text"], fontsize=11)
    if path is not None:
        fig.savefig(path, dpi=130)
        plt.close(fig)
    return fig
