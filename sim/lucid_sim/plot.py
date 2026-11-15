"""Quick-look plot of one simulated session, for checking scenarios by eye."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .hardware import DEFAULT_DETECTOR, DETECTORS, to_units
from .session import pair_summary, raw_frames

SIDE_COLORS = {"L": "#3b82f6", "R": "#f97316"}


def quick_look(session: pd.DataFrame, path=None, title: str | None = None):
    import matplotlib

    if path is not None:
        matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    scenario = session.attrs.get("scenario", {})
    u = to_units(raw_frames(session), DETECTORS[scenario.get("detector", DEFAULT_DETECTOR.name)])
    t = u["t_s"].to_numpy()
    fig = plt.figure(figsize=(13, 11), constrained_layout=True)
    grid = fig.add_gridspec(5, 2, width_ratios=[4, 1.3])
    axes = [fig.add_subplot(grid[i, 0]) for i in range(5)]
    for ax in axes[1:]:
        ax.sharex(axes[0])

    # Shade each hold by side, label it, and hatch any artifact.
    holds = session[session["true_phase"] == "hold"].groupby("true_dwell")
    for _, h in holds:
        spot = h["true_spot"].iloc[0]
        t0, t1 = h["t_ms"].iloc[[0, -1]] / 1000
        for ax in axes:
            ax.axvspan(t0, t1, color=SIDE_COLORS[spot[0]], alpha=0.08, lw=0)
        axes[0].text((t0 + t1) / 2, 1.02, spot.replace("-", "\n"), transform=axes[0].get_xaxis_transform(),
                     ha="center", va="bottom", fontsize=7, color=SIDE_COLORS[spot[0]])
    bad = session["true_artifact"].to_numpy() != ""
    for ax in axes:
        ax.fill_between(t, 0, 1, where=bad, transform=ax.get_xaxis_transform(), color="red", alpha=0.15, lw=0)

    good = session["true_good"].to_numpy()
    axes[0].plot(t, u["coil_dbm"], lw=0.6, color="0.6")
    axes[0].plot(t, np.where(good, u["coil_dbm"], np.nan), lw=0.8, color="k")
    in_contact = session["true_liftoff_mm"] < 10
    lo, hi = np.percentile(u["coil_dbm"][in_contact], [1, 99]) if in_contact.any() else (None, None)
    if lo is not None:
        axes[0].set_ylim(lo - 0.3, u["coil_dbm"].max() + 0.1)
    axes[0].set_ylabel(f"coil (dBm, {scenario.get('detector', DEFAULT_DETECTOR.name)})")

    axes[1].plot(t, u["ir_net_v"], lw=0.6, color="0.2", label="LED on - off")
    axes[1].plot(t, u["ir_amb_v"], lw=0.6, color="goldenrod", label="ambient")
    axes[1].set_ylabel("IR (V)")
    axes[1].legend(loc="upper right", fontsize=7)

    for axis, color in zip("xyz", ("tab:red", "tab:green", "tab:blue")):
        axes[2].plot(t, u[f"a{axis}_g"], lw=0.5, color=color, label=axis)
        axes[3].plot(t, u[f"g{axis}_dps"], lw=0.5, color=color, label=axis)
    axes[2].set_ylabel("accel (g)")
    axes[3].set_ylabel("gyro (°/s)")
    axes[2].legend(loc="upper right", fontsize=7, ncol=3)

    axes[4].plot(t, session["true_liftoff_mm"], lw=0.8, color="purple")
    axes[4].set_ylim(-0.5, 12)
    axes[4].set_ylabel("true gap (mm)")
    axes[4].set_xlabel("time (s)")
    for ax in axes[:-1]:
        ax.tick_params(labelbottom=False)

    # Left/right pair comparison over the good samples.
    pairs = pair_summary(session)
    first = pairs.groupby("region", sort=False).head(1).set_index("region")
    order = [r for r in ("frontal", "frontotemporal", "temporal", "parietal", "occipital") if r in first.index]
    first = first.loc[order]
    y = np.arange(len(first))
    bar_coil = fig.add_subplot(grid[0:2, 1])
    bar_coil.barh(y, first["coil_R_minus_L_db"], color=np.where(first["coil_R_minus_L_db"] < 0, SIDE_COLORS["R"], SIDE_COLORS["L"]))
    bar_coil.set_yticks(y, order, fontsize=8)
    bar_coil.invert_yaxis()
    bar_coil.axvline(0, color="k", lw=0.6)
    bar_coil.set_title("coil R - L (dB)\nlower = more loss on R", fontsize=9)
    bar_od = fig.add_subplot(grid[2:4, 1])
    bar_od.barh(y, first["od_R_minus_L"], color=np.where(first["od_R_minus_L"] > 0, SIDE_COLORS["R"], SIDE_COLORS["L"]))
    bar_od.set_yticks(y, order, fontsize=8)
    bar_od.invert_yaxis()
    bar_od.axvline(0, color="k", lw=0.6)
    bar_od.set_title("optical density R - L\nhigher = darker on R", fontsize=9)

    fig.suptitle(title or scenario.get("subject", "Lucid simulated session"), fontsize=11)
    if path is not None:
        fig.savefig(path, dpi=130)
        plt.close(fig)
    return fig
