"""Build static/race.json: a crowd of simulated patients scanned through the real pipeline, for the race view.

    python -m lucid_ui.make_race            # 100 bleeds + 100 healthy heads, a few minutes on 8 cores
    python -m lucid_ui.make_race --n 40     # quicker

Each patient is a full simulated scan (with some handling problems) read by `lucid_interp`. For the chance of
bleed after 0, 1, ... 10 spots, the location fit is rerun on the spots read so far, the same way the live
scan does it, so every line is what the screen would have shown for that patient.
"""
from __future__ import annotations

import argparse
import json
from multiprocessing import Pool
from pathlib import Path

import numpy as np

import lucid_sim as ls
from lucid_sim.anatomy import HEAD_RADIUS_MM
from lucid_interp.layers import Calibration, _pairs, interpret
from lucid_interp.locate import HUMAN_PRIOR, locate_pairs

OUT = Path(__file__).parent / "static" / "race.json"
PREVALENCE = 0.1
KINDS = (("subdural", 0.5), ("epidural", 0.25), ("intracerebral", 0.25))


def geometry(spot: str, volume: float, kind: str) -> dict:
    """Where the bleed sits, for drawing: its centre (mm, head frame) and a radius."""
    centre, depth, thick, spread = ls.Bleed(spot, volume, kind).geometry(ls.HUMAN)
    pos = centre * (HEAD_RADIUS_MM - depth - thick / 2)
    return {"pos": [round(float(v), 1) for v in pos], "radius": round(float(max(spread, thick / 2)), 1)}


def patient(i: int, bleed: bool) -> dict:
    rng = np.random.default_rng(10_000 + i)
    bleeds, info = [], {"bleed": bleed}
    if bleed:
        kind = rng.choice([k for k, _ in KINDS], p=[w for _, w in KINDS])
        spot = ls.DEFAULT_SPOTS[rng.integers(len(ls.DEFAULT_SPOTS))]
        volume = float(rng.uniform(10, 60))
        bleeds = [ls.Bleed(spot, volume, str(kind))]
        info.update(kind=str(kind), spot=spot.id, volume=round(volume, 1), **geometry(spot.id, volume, str(kind)))
    plan = ls.add_random_artifacts(ls.default_plan(), 0.2, seed=i)
    session = ls.simulate(ls.Subject(ls.HUMAN, bleeds, seed=i), plan, seed=i)
    cal = Calibration()
    interp = interpret(ls.raw_frames(session), calibration=cal)
    spots = interp.spots
    curve = [PREVALENCE]
    for k in range(1, len(ls.DEFAULT_SPOTS) + 1):
        read = spots.iloc[:k]
        ok = read[read["status"] == "ok"]
        pairs = _pairs(ok, cal) if len(ok) else None
        if pairs is None or not np.isfinite(pairs["z"]).any():
            curve.append(curve[-1])
            continue
        bf = locate_pairs(pairs, cal.coil.decay_mm, HUMAN_PRIOR, blood=False).summary["bayes_factor"]
        curve.append(bf * PREVALENCE / (bf * PREVALENCE + 1 - PREVALENCE) if np.isfinite(bf) else 1.0)
    flag = interp.flag
    info.update(
        curve=[round(float(p), 4) for p in curve],
        flag=flag["status"], flag_side=flag.get("side", ""),
        caught=bool(bleed and flag["status"] == "asymmetry" and flag.get("side") == info["spot"][0]),
        false_alarm=bool(not bleed and flag["status"] in ("asymmetry", "conflicting")),
    )
    return info


def _run(args):
    return patient(*args)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m lucid_ui.make_race")
    parser.add_argument("--n", type=int, default=100, help="patients of each kind (bleed, healthy)")
    args = parser.parse_args(argv)
    jobs = [(i, True) for i in range(args.n)] + [(args.n + i, False) for i in range(args.n)]
    with Pool() as pool:
        patients = pool.map(_run, jobs, chunksize=4)
    OUT.write_text(json.dumps({"prevalence": PREVALENCE, "spots": [s.id for s in ls.DEFAULT_SPOTS],
                               "patients": patients}, separators=(",", ":")))
    bleeds = [p for p in patients if p["bleed"]]
    healthy = [p for p in patients if not p["bleed"]]
    print(f"wrote {OUT}: caught {sum(p['caught'] for p in bleeds)}/{len(bleeds)} bleeds, "
          f"{sum(p['false_alarm'] for p in healthy)}/{len(healthy)} false alarms")


if __name__ == "__main__":
    main()
