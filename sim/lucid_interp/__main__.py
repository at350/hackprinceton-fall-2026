"""Interpret a recorded scan: a CSV from `python -m lucid_sim generate`, or a raw serial log.

    python -m lucid_interp runs/human_L_temporal.csv --plot runs/human_L_temporal_interp.png
    python -m lucid_interp runs/human_L_temporal.log --render runs/human_L_temporal_head.png
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from lucid_sim.hardware import DEFAULT_DETECTOR, DETECTORS, read_serial_log

from .layers import Calibration, interpret
from .locate import PRIORS, locate
from .truth import compare_to_truth

LAYER_COLUMNS = ["spot", "freq_hz", "status", "good_s", "gap_mm", "gap_se", "sigma", "sigma_se", "od", "pulse_bpm",
                 "tremor_g", "flicker_v", "note"]
PAIR_COLUMNS = ["region", "sigma_L", "sigma_R", "d_sigma", "d_sigma_se", "z", "gap_L_mm", "gap_R_mm", "d_od"]


def load(path: Path) -> pd.DataFrame:
    if path.suffix in (".log", ".txt"):
        return read_serial_log(path)
    df = pd.read_csv(path)
    for col in ("true_phase", "true_spot", "true_artifact"):
        if col in df:
            df[col] = df[col].fillna("")
    return df


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m lucid_interp", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("path", type=Path)
    parser.add_argument("--plot", help="save a PNG of the layers and one spot's Fourier split")
    parser.add_argument("--spot", help="spot to decompose in the plot (default: the flagged one)")
    parser.add_argument("--mains", type=float, default=60.0, help="mains frequency, Hz")
    parser.add_argument("--json", help="also write the flag and tables as JSON (for the agents)")
    parser.add_argument("--detector", choices=sorted(DETECTORS),
                        help="coil detector on the board (default: from the scenario file, else the diode)")
    parser.add_argument("--render", help="save a PNG of where in the head the bleed most likely is")
    parser.add_argument("--medium", choices=sorted(PRIORS),
                        help="what was scanned, for the bleed-size prior (default: from the scenario file, else human)")
    args = parser.parse_args(argv)

    frames = load(args.path)
    sidecar = args.path.with_suffix(".json")
    scenario = json.loads(sidecar.read_text()) if sidecar.exists() else {}
    detector = DETECTORS[args.detector or scenario.get("detector", DEFAULT_DETECTOR.name)]
    interp = interpret(frames, calibration=Calibration(detector=detector, mains_hz=args.mains))
    print(f"detector: {detector.name}\n")
    with pd.option_context("display.width", 200, "display.max_columns", 30, "display.precision", 3):
        print(interp.layers[[c for c in LAYER_COLUMNS if c in interp.layers]].to_string(index=False))
        print()
        print(interp.pairs[[c for c in PAIR_COLUMNS if c in interp.pairs]].to_string(index=False))
        print()
        print(interp.flag["text"])
        for note in interp.flag["notes"]:
            print("note:", note)
        loc = locate(interp, PRIORS[args.medium or scenario.get("medium", "human")])
        print("\nlocation:", loc.summary["text"])
        if "true_sigma" in frames:
            print("\nAgainst simulator truth:")
            print(compare_to_truth(interp, frames).to_string(index=False))
    if args.plot:
        from .plot import interpretation_figure

        interpretation_figure(interp, args.plot, spot=args.spot)
        print(f"\nwrote {args.plot}")
    if args.render:
        from .render import render_head

        render_head(loc, args.render, title=args.path.stem)
        print(f"wrote {args.render}")
    if args.json:
        out = {"flag": interp.flag, "spots": interp.spots.to_dict(orient="records"),
               "pairs": interp.pairs.to_dict(orient="records"), "location": loc.summary,
               "cloud": loc.cloud_records()}
        Path(args.json).write_text(json.dumps(out, indent=2, default=float))
        print(f"wrote {args.json}")


if __name__ == "__main__":
    main()
