"""Command line: generate sessions to files, stream them live like the Arduino, or plot them.

    python -m lucid_sim generate -o runs/demo.csv --bleed L-temporal --plot runs/demo.png
    python -m lucid_sim stream --pty --medium phantom --bleed R-parietal --kind balloon --volume 100
    python -m lucid_sim plot runs/demo.csv
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import pandas as pd

from . import hardware as hw
from .anatomy import BLEED_KINDS, MEDIA, Bleed, Subject
from .channels import CoilModel
from .session import add_random_artifacts, default_plan, pair_summary, raw_frames, serial_lines, simulate

TRUTH_TEXT_COLUMNS = ["true_phase", "true_spot", "true_artifact"]


def add_scenario_args(p: argparse.ArgumentParser):
    p.add_argument("--medium", choices=sorted(MEDIA), default="human")
    p.add_argument("--bleed", action="append", default=[], metavar="SPOT",
                   help="spot over the bleed, e.g. L-temporal (repeat for several); none = healthy")
    p.add_argument("--volume", type=float, default=30.0, help="bleed volume, ml")
    p.add_argument("--kind", choices=BLEED_KINDS, default=None, help="default: subdural, or balloon for the phantom")
    p.add_argument("--depth", type=float, default=None, help="mm from the surface to the bleed's near edge")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--artifacts", type=float, default=0.0, metavar="RATE",
                   help="share of spots with a handling problem (slip, wobble, lift, shake, poor contact)")
    p.add_argument("--hold", type=float, default=3.0, help="seconds held on each spot")
    p.add_argument("--freqs", default="3e6", help="coil frequencies in Hz, comma separated, stepped during each hold")
    p.add_argument("--posture", choices=["supine", "upright"], default=None)
    p.add_argument("--heart-rate", type=float, default=75.0)
    p.add_argument("--detector", choices=sorted(hw.DETECTORS), default=hw.DEFAULT_DETECTOR.name,
                   help="coil detector on the board (default: %(default)s diode)")
    p.add_argument("--drive-dbm", type=float, default=CoilModel().drive_dbm,
                   help="coil level at the detector in air, dBm into 50 ohm (0 = 0.32 V peak, 10 = 1 V peak)")


def build_session(args) -> pd.DataFrame:
    medium = MEDIA[args.medium]
    kind = args.kind or ("balloon" if args.medium == "phantom" else "subdural")
    bleeds = [Bleed(spot, args.volume, kind, args.depth) for spot in args.bleed]
    subject = Subject(medium, bleeds, heart_rate_bpm=args.heart_rate, seed=args.seed)
    freqs = tuple(float(f) for f in args.freqs.split(","))
    plan = default_plan(hold_s=args.hold, freqs_hz=freqs)
    if args.artifacts > 0:
        plan = add_random_artifacts(plan, args.artifacts, seed=args.seed)
    return simulate(subject, plan, posture=args.posture, seed=args.seed, detector=hw.DETECTORS[args.detector],
                    coil=CoilModel(drive_dbm=args.drive_dbm))


def load_session(path) -> pd.DataFrame:
    """Read a CSV written by `generate`, with its scenario sidecar if present."""
    path = Path(path)
    df = pd.read_csv(path)
    for col in TRUTH_TEXT_COLUMNS:
        if col in df:
            df[col] = df[col].fillna("")
    sidecar = path.with_suffix(".json")
    if sidecar.exists():
        df.attrs["scenario"] = json.loads(sidecar.read_text())
    return df


def cmd_generate(args):
    session = build_session(args)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    session.to_csv(out, index=False)
    out.with_suffix(".json").write_text(json.dumps(session.attrs["scenario"], indent=2))
    print(f"wrote {out} ({len(session)} frames, {session['t_ms'].iloc[-1] / 1000:.1f} s): "
          f"{session.attrs['scenario']['subject']}")
    if args.serial:
        Path(args.serial).write_text("\n".join(serial_lines(session)) + "\n")
        print(f"wrote {args.serial} (raw serial frames, as the Arduino sends them)")
    if args.plot:
        from .plot import quick_look

        quick_look(session, args.plot)
        print(f"wrote {args.plot}")
    with pd.option_context("display.width", 160, "display.max_columns", 20, "display.precision", 3):
        print(pair_summary(session).drop(columns=["freq_hz"] if session["freq_hz"].nunique() == 1 else []))


def cmd_plot(args):
    from .plot import quick_look

    session = load_session(args.csv)
    out = args.out or str(Path(args.csv).with_suffix(".png"))
    quick_look(session, out)
    print(f"wrote {out}")


class _PtyPort:
    """A virtual serial port: the app opens the printed path with pyserial like a real Arduino."""

    def __init__(self):
        import termios
        import tty

        self._termios = termios
        self.master, self.slave = os.openpty()
        tty.setraw(self.slave)
        os.set_blocking(self.master, False)
        self.path = os.ttyname(self.slave)

    def write(self, data: bytes):
        try:
            os.write(self.master, data)
        except BlockingIOError:
            # Nobody is reading: drop stale data so a new reader gets live frames, like a real port.
            self._termios.tcflush(self.slave, self._termios.TCIFLUSH)


def cmd_stream(args):
    if args.pty:
        port = _PtyPort()
        print(f"streaming on {port.path}  (open it with pyserial, any baud rate)", file=sys.stderr, flush=True)
        write = port.write
    else:
        def write(data: bytes):
            sys.stdout.buffer.write(data)
            sys.stdout.flush()

    write((hw.HEADER + "\n").encode())
    t_offset_ms = 0
    start = time.monotonic()
    run = 0
    while True:
        args_run = argparse.Namespace(**{**vars(args), "seed": args.seed + run})
        session = build_session(args_run)
        print(f"# scan {run + 1}: {session.attrs['scenario']['subject']}", file=sys.stderr, flush=True)
        frames = raw_frames(session).to_numpy()
        for row in frames:
            row = row.copy()
            row[0] += t_offset_ms  # millis() keeps counting across scans
            due = start + row[0] / 1000.0 / args.speed
            delay = due - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            write((hw.format_frame(row) + "\n").encode())
        t_offset_ms = int(row[0]) + 10
        run += 1
        if not args.loop:
            break


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m lucid_sim", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    gen = sub.add_parser("generate", help="simulate a scan and write it to files")
    add_scenario_args(gen)
    gen.add_argument("-o", "--out", default="runs/session.csv", help="CSV with raw columns and true_* labels")
    gen.add_argument("--serial", help="also write the raw serial log, exactly as the Arduino would send it")
    gen.add_argument("--plot", help="also save a quick-look PNG")
    gen.set_defaults(func=cmd_generate)

    stream = sub.add_parser("stream", help="play scans in real time, like the Arduino on USB")
    add_scenario_args(stream)
    stream.add_argument("--pty", action="store_true", help="serve on a virtual serial port instead of stdout")
    stream.add_argument("--speed", type=float, default=1.0, help="playback speed multiplier")
    stream.add_argument("--loop", action="store_true", help="keep scanning (new seed each scan)")
    stream.set_defaults(func=cmd_stream)

    plot = sub.add_parser("plot", help="quick-look PNG of a generated CSV")
    plot.add_argument("csv")
    plot.add_argument("-o", "--out")
    plot.set_defaults(func=cmd_plot)

    args = parser.parse_args(argv)
    try:
        args.func(args)
    except KeyboardInterrupt:
        pass
    except BrokenPipeError:
        # The reader went away (e.g. piped into head); exit quietly.
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())


if __name__ == "__main__":
    main()
