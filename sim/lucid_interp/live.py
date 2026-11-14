"""Live scan: interpret readings as they arrive, and after each finished spot run a batch of physics
simulations to predict the spots still to come and suggest which to scan next.

Each update:
1. Re-interprets everything so far (about 0.1 s for a whole scan) and keeps the spots the probe has left.
2. Checks each new spot against what the last round of simulations predicted for it. A reading far
   outside the prediction changed the picture: either it found something or the contact was bad, and
   only a second reading tells which, so it is suggested for a confirming rescan.
3. Refits the bleed location from the finished pairs and turns its Bayes factor into a chance of bleed.
4. Simulates `n_sims` heads that fit the data so far: healthy heads, or bleeds drawn from the fitted
   posterior. Each gets natural L/R asymmetry and measurement noise, and its coil reading is computed
   from the coil physics (`CoilModel`) at the gap the probe has been seeing.
5. From those, gives each remaining spot a predicted conductivity and coil loss (healthy vs bleed), and
   suggests what to scan next: a retake, then a confirming rescan, then the spot whose reading would
   split the simulated heads the most.

    python -m lucid_interp.live runs/demo.log                     # replay a recording
    python -m lucid_sim stream --bleed L-temporal | python -m lucid_interp.live -
    python -m lucid_interp.live /dev/ttys004 --jsonl live.jsonl    # the board, or `lucid_sim stream --pty`
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from lucid_sim.anatomy import DEFAULT_SPOTS, Spot
from lucid_sim.hardware import COLUMNS, DEFAULT_DETECTOR, DETECTORS, parse_frame

from .layers import Calibration, Interpretation, _pairs, interpret
from .locate import HUMAN_PRIOR, PRIORS, BleedPrior, Location, bleed_rise, locate_pairs


@dataclass
class Update:
    t_s: float
    done: list[str]  # spots the probe has finished, in scan order
    retake: list[str]
    pairs_done: int
    p_bleed: float
    location: dict
    predictions: pd.DataFrame  # one row per spot still to scan
    next_spot: str | None
    confirm: list[str]  # spots whose reading the simulations didn't expect: rescan once to confirm
    surprises: list[str]
    text: str
    final: bool = False

    def to_dict(self) -> dict:
        return {"t_s": self.t_s, "done": self.done, "retake": self.retake, "pairs_done": self.pairs_done,
                "p_bleed": self.p_bleed, "location": self.location, "next_spot": self.next_spot,
                "confirm": self.confirm, "surprises": self.surprises, "text": self.text, "final": self.final,
                "predictions": self.predictions.to_dict(orient="records")}


class LiveScan:
    """Feed it serial lines (or frame dicts) as they arrive; it returns an `Update` whenever a spot finishes.

    Contacts are matched to `plan` in order. When the operator goes to a suggested spot out of order, or
    rescans one, call `follow(spot)` while the probe is in the air so the next contact gets that label.
    A rescanned spot's readings are pooled with its first ones.
    """

    def __init__(self, spots=DEFAULT_SPOTS, calibration: Calibration = Calibration(),
                 prior: BleedPrior = HUMAN_PRIOR, prevalence: float = 0.1, n_sims: int = 500,
                 settle_s: float = 1.0, every_s: float = 0.5, seed: int | None = 0):
        self.plan = [Spot.parse(s) for s in spots]
        self.cal, self.prior = calibration, prior
        self.prevalence = prevalence  # chance of a bleed before any reading
        self.n_sims = n_sims
        self.settle_s = settle_s  # probe must be off a spot this long before the spot counts as finished
        self.every_s = every_s
        self.rng = np.random.default_rng(seed)
        self.updates: list[Update] = []
        self.interp: Interpretation | None = None
        self.location: Location | None = None
        self._rows: list[dict] = []
        self._last_run_ms: float | None = None
        self._done: tuple[str, ...] = ()
        self._predicted: dict[str, tuple[float, float]] = {}
        self._checked: set[str] = set()
        self._confirm: list[str] = []

    # Input

    def feed(self, item: str | dict) -> Update | None:
        row = parse_frame(item) if isinstance(item, str) else dict(item)
        if row is None:
            return None
        self._rows.append(row)
        t = row["t_ms"]
        if self._last_run_ms is not None and t - self._last_run_ms < self.every_s * 1000:
            return None
        self._last_run_ms = t
        return self._check()

    def feed_many(self, items) -> list[Update]:
        return [u for item in items if (u := self.feed(item)) is not None]

    def follow(self, spot: Spot | str) -> None:
        spot = Spot.parse(spot)
        taken = len(self.interp.contacts) if self.interp else 0
        head, rest = self.plan[:taken], self.plan[taken:]
        if spot in rest:
            rest.remove(spot)
        elif spot.id in self._confirm:
            self._confirm.remove(spot.id)
        self.plan = head + [spot] + rest

    def finish(self) -> Update | None:
        """The scan is over: count every contact, paint the blood map, and give the last update."""
        if len(self._rows) < 10:
            return None
        self.interp = interpret(self._frames(), spots=self.plan, calibration=self.cal)
        self._done = tuple(c.spot for c in self.interp.contacts if c.spot and not c.spot.startswith("extra"))
        return self._update(final=True)

    # Internals

    def _frames(self) -> pd.DataFrame:
        return pd.DataFrame(self._rows, columns=list(COLUMNS))

    def _check(self) -> Update | None:
        frames = self._frames()
        if len(frames) < 300:
            return None
        interp = interpret(frames, spots=self.plan, calibration=self.cal)
        cutoff = len(frames) - self.settle_s * interp.fs
        done = tuple(c.spot for c in interp.contacts
                     if c.end <= cutoff and c.spot and not c.spot.startswith("extra"))
        self.interp = interp
        if done == self._done:
            return None
        self._done = done
        return self._update(final=False)

    def _update(self, final: bool) -> Update:
        interp, done = self.interp, list(dict.fromkeys(self._done))
        spots = interp.spots[interp.spots["spot"].isin(done)] if len(interp.spots) else interp.spots
        ok = spots[spots["status"] == "ok"] if len(spots) else spots
        retake = spots.loc[spots["status"] != "ok", "spot"].tolist() if len(spots) else []

        surprises = []
        for row in ok.itertuples():
            if row.spot in self._predicted and row.spot not in self._checked:
                self._checked.add(row.spot)
                mean, sd = self._predicted[row.spot]
                z = (row.sigma - mean) / np.hypot(sd, row.sigma_se)
                if abs(z) > 3:
                    surprises.append(f"{row.spot} changed the picture: {row.sigma:.3f} S/m against "
                                     f"{mean:.3f} ± {sd:.3f} expected. Rescan it once to confirm.")
                    if row.spot not in self._confirm:
                        self._confirm.append(row.spot)

        pairs = _pairs(ok, self.cal) if len(ok) else pd.DataFrame({"region": pd.Series(dtype=str), "z": pd.Series(dtype=float)})
        pairs_done = int(np.isfinite(pairs["z"].astype(float)).sum()) if len(pairs) else 0
        loc = locate_pairs(pairs, self.cal.coil.decay_mm, self.prior, blood=final)
        self.location = loc
        bf, prev = loc.summary["bayes_factor"], self.prevalence
        p_bleed = bf * prev / (bf * prev + 1 - prev) if np.isfinite(bf) else 1.0

        confirm = [] if final else list(self._confirm)
        pending = [s for s in self.plan if s.id not in done] + [Spot.parse(s) for s in retake + confirm]
        predictions = self._simulate(ok, loc, p_bleed, pending) if pending and not final else pd.DataFrame()
        next_spot = None
        if retake or confirm:
            next_spot = (retake + confirm)[0]
        elif len(predictions):
            # Keep to the planned order unless a finished pair has made another spot clearly more telling.
            planned = predictions.iloc[0]
            best = predictions.loc[predictions["info"].idxmax()]
            next_spot = best["spot"] if pairs_done and best["info"] > 2 * planned["info"] + 0.1 else planned["spot"]
        t_s = float(self._rows[-1]["t_ms"]) / 1000

        update = Update(t_s, done, retake, pairs_done, float(p_bleed), loc.summary, predictions, next_spot,
                        confirm, surprises, "", final)
        update.text = self._describe(update, interp)
        self.updates.append(update)
        return update

    def _simulate(self, ok: pd.DataFrame, loc: Location, p_bleed: float, pending: list[Spot]) -> pd.DataFrame:
        """Simulate `n_sims` heads that fit the data so far and predict each pending spot's reading."""
        rng, n, prior, cal = self.rng, self.n_sims, self.prior, self.cal
        all_ids = [s.id for s in DEFAULT_SPOTS]
        dirs = np.array([s.direction for s in DEFAULT_SPOTS])
        col = {sid: i for i, sid in enumerate(all_ids)}

        bleed = rng.random(n) < p_bleed
        rise = np.zeros((n, len(all_ids)))
        if bleed.any():
            k = int(bleed.sum())
            if loc.log_like is not None:
                pts, spread, contrast = loc.sample(k, rng)
            else:  # nothing fitted yet: bleeds from the prior
                pts = loc.voxels[rng.integers(len(loc.voxels), size=k)]
                spread = rng.choice(prior.spreads_mm, size=k)
                contrast = rng.uniform(0, prior.max_contrast, size=k)
            rise[bleed] = bleed_rise(pts, spread, contrast, dirs, loc.decay_mm)

        by_spot = ok.set_index("spot") if len(ok) else None
        se_typ = float(ok["sigma_se"].median()) if len(ok) else 0.01
        gap_typ = float(ok["gap_mm"].median()) if len(ok) else cal.fallback_gap_mm[0]
        if len(ok):  # healthy tissue level implied by the finished spots, per simulated head
            implied = ok["sigma"].to_numpy()[None, :] - rise[:, [col[s] for s in ok["spot"]]]
            tissue = implied.mean(axis=1)
        else:
            tissue = np.full(n, prior.tissue_sigma)

        coil, f0 = cal.coil, cal.coil.f0_hz
        rows = []
        for spot in dict.fromkeys(pending):
            mirror = spot.mirror.id
            if by_spot is not None and mirror in by_spot.index:
                m = by_spot.loc[mirror]
                base = m["sigma"] - rise[:, col[mirror]]
                noise = np.sqrt(cal.asymmetry_sd**2 + m["sigma_se"] ** 2 + se_typ**2)
                gap = float(m["gap_mm"])
            else:
                base, noise, gap = tissue, np.hypot(prior.region_sd, se_typ), gap_typ
            sigma = base + rise[:, col[spot.id]] + rng.normal(0, noise, n)
            loss = coil.dbm(f0, np.maximum(sigma, 0), gap) - coil.dbm(f0, 0.0, 0.0)  # the coil physics
            # How much this spot's reading would tell the simulated heads apart, in noise units.
            contrast = rise[:, col[spot.id]] - rise[:, col[mirror]]
            rows.append({"spot": spot.id, "mirror_done": by_spot is not None and mirror in by_spot.index,
                         "sigma_healthy": float(sigma[~bleed].mean()) if (~bleed).any() else np.nan,
                         "sigma_if_bleed": float(sigma[bleed].mean()) if bleed.any() else np.nan,
                         "sigma_mean": float(sigma.mean()), "sigma_sd": float(sigma.std()),
                         "loss_db_lo": float(np.percentile(loss, 10)), "loss_db_hi": float(np.percentile(loss, 90)),
                         "gap_mm": gap, "info": float(contrast.var() / noise**2)})
            self._predicted[spot.id] = (float(sigma.mean()), float(sigma.std()))
            self._checked.discard(spot.id)
        return pd.DataFrame(rows)

    def _describe(self, u: Update, interp: Interpretation) -> str:
        head = (f"[{u.t_s:5.1f} s] {len(u.done)}/{len(set(self.plan))} spots, {u.pairs_done}/5 pairs. "
                f"Chance of bleed {u.p_bleed:.0%} (before scanning {self.prevalence:.0%}).")
        lines = [head]
        if u.pairs_done and u.location.get("status") != "none":
            lines.append("  " + u.location["text"])
        if u.final:
            lines.append("  Screening flag: " + interp.flag["text"])
        for s in u.surprises:
            lines.append("  ! " + s)
        if u.retake:
            lines.append("  Retake: " + ", ".join(u.retake))
        if u.next_spot is not None and len(u.predictions):
            p = u.predictions.set_index("spot").loc[u.next_spot]
            why = ("retake" if u.next_spot in u.retake else "confirm" if u.next_spot in u.confirm
                   else "finishes a pair" if p["mirror_done"] else "new region")
            expect = [f"{p[k]:.3f} S/m if {name}" for k, name in (("sigma_healthy", "healthy"),
                                                                  ("sigma_if_bleed", "bleed")) if np.isfinite(p[k])]
            lines.append(f"  Next: {u.next_spot} ({why}). Simulated heads expect {', '.join(expect)}; coil "
                         f"{p['loss_db_lo']:.2f} to {p['loss_db_hi']:.2f} dB.")
        return "\n".join(lines)


def _lines(source: str, speed: float):
    """Serial lines from stdin, a serial device, a .log, or a simulator .csv (replayed at `speed`, 0 = flat out)."""
    if source == "-":
        yield from sys.stdin
        return
    path = Path(source)
    if path.suffix == ".csv":
        df = pd.read_csv(path)
        rows = (",".join(str(int(v)) for v in r) for r in df[list(COLUMNS)].itertuples(index=False))
    else:
        rows = open(path, errors="replace")
    start = time.monotonic()
    for line in rows:
        if speed > 0 and (frame := parse_frame(line)) is not None:
            delay = start + frame["t_ms"] / 1000 / speed - time.monotonic()
            if delay > 0:
                time.sleep(delay)
        yield line


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m lucid_interp.live", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", help="'-' for stdin, a serial device, a .log or a simulator .csv")
    parser.add_argument("--speed", type=float, default=0.0, help="replay speed for files (0 = as fast as possible)")
    parser.add_argument("--medium", choices=sorted(PRIORS), default="human")
    parser.add_argument("--detector", choices=sorted(DETECTORS), default=DEFAULT_DETECTOR.name)
    parser.add_argument("--prevalence", type=float, default=0.1, help="chance of a bleed before scanning")
    parser.add_argument("--sims", type=int, default=500, help="simulated heads per update")
    parser.add_argument("--jsonl", help="append each update as a JSON line (for the app and agents)")
    parser.add_argument("--render", help="save the final 3D head map")
    args = parser.parse_args(argv)

    scan = LiveScan(calibration=Calibration(detector=DETECTORS[args.detector]), prior=PRIORS[args.medium],
                    prevalence=args.prevalence, n_sims=args.sims)
    out = open(args.jsonl, "a") if args.jsonl else None

    def emit(update):
        print(update.text + "\n", flush=True)
        if out:
            out.write(json.dumps(update.to_dict(), default=float) + "\n")
            out.flush()

    try:
        for line in _lines(args.source, args.speed):
            if (update := scan.feed(line)) is not None:
                emit(update)
    except KeyboardInterrupt:
        pass
    final = scan.finish()
    if final is not None:
        emit(final)
        if args.render:
            from .render import render_head

            render_head(scan.location, args.render, title="live scan")
            print(f"wrote {args.render}")


if __name__ == "__main__":
    main()
