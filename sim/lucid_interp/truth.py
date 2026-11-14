"""Score an interpretation against the simulator's ground truth (true_* columns)."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .layers import Interpretation


def compare_to_truth(interp: Interpretation, session: pd.DataFrame) -> pd.DataFrame:
    """Per spot: estimated vs true gap and conductivity, and how many kept samples were truly bad."""
    rows = []
    spots = interp.spots.set_index("spot")
    for c in interp.contacts:
        part = session.iloc[c.slice]
        good = c.good
        truth_spot = part.loc[part["true_spot"] != "", "true_spot"]
        row = {
            "spot": c.spot,
            "true_spot": truth_spot.mode().iloc[0] if len(truth_spot) else "",
            "status": spots.loc[c.spot, "status"],
            "kept_s": good.sum() / interp.fs,
            "kept_but_bad": int((part["true_artifact"].to_numpy()[good] != "").sum()),
            "truly_good_s": part["true_good"].sum() / interp.fs,
        }
        if spots.loc[c.spot, "status"] == "ok" and good.any():
            row.update(gap_mm=spots.loc[c.spot, "gap_mm"], true_gap_mm=part["true_liftoff_mm"].to_numpy()[good].mean(),
                       sigma=spots.loc[c.spot, "sigma"], true_sigma=part["true_sigma"].to_numpy()[good].mean())
        rows.append(row)
    out = pd.DataFrame(rows)
    if "sigma" in out:
        out["sigma_err_pct"] = 100 * (out["sigma"] / out["true_sigma"] - 1)
    return out
