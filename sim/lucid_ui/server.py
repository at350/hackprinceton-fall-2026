"""Lucid live UI: plays a scan (simulated, a recording, or the board) through `LiveScan` and streams the
signals and every update, simulations included, to the browser over Server-Sent Events.

    python -m lucid_ui                          # http://localhost:8765, pick a scenario, press Start
    python -m lucid_ui --serial /dev/ttys004    # the board, or `python -m lucid_sim stream --pty`
    python -m lucid_ui --replay runs/human_L_temporal.csv

Standard library server, no extra dependencies.
"""
from __future__ import annotations

import argparse
import base64
import json
import queue
import threading
import time
from collections import deque
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

import lucid_sim as ls
from lucid_interp.layers import Calibration
from lucid_interp.live import LiveScan
from lucid_interp.locate import PRIORS
from lucid_sim.anatomy import DEFAULT_SPOTS, HEAD_RADIUS_MM
from lucid_sim.hardware import COLUMNS, DEFAULT_DETECTOR, DETECTORS, parse_frame, to_units

from .make_brain import OUT as BRAIN_PATH
from .make_brain import load as load_brain

STATIC = Path(__file__).parent / "static"

SCENARIOS = {
    "subdural": ("30 ml subdural, left temporal", ls.HUMAN, [ls.Bleed("L-temporal", 30, "subdural")]),
    "epidural": ("40 ml epidural, right frontotemporal", ls.HUMAN, [ls.Bleed("R-frontotemporal", 40, "epidural")]),
    "deep": ("30 ml deep bleed, right frontal", ls.HUMAN, [ls.Bleed("R-frontal", 30, "intracerebral")]),
    "healthy": ("Healthy head", ls.HUMAN, []),
    "phantom": ("Saline phantom, 100 ml balloon, right parietal", ls.SALINE_PHANTOM,
                [ls.Bleed("R-parietal", 100, "balloon")]),
}


def _round(x, nd=3):
    return np.round(np.asarray(x, float), nd).tolist()


class Hub:
    """Fan-out of events to every connected browser; remembers the last of each kind for late joiners."""

    def __init__(self):
        self.clients: list[queue.Queue] = []
        self.last: dict[str, str] = {}
        self.lock = threading.Lock()

    def publish(self, event: str, data: dict, remember: bool = False):
        msg = f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'), default=float)}\n\n"
        with self.lock:
            if remember:
                self.last[event] = msg
            for q in self.clients:
                q.put(msg)

    def subscribe(self) -> queue.Queue:
        q = queue.Queue()
        with self.lock:
            for event in ("hello", "update"):
                if event in self.last:
                    q.put(self.last[event])
            self.clients.append(q)
        return q

    def unsubscribe(self, q):
        with self.lock:
            if q in self.clients:
                self.clients.remove(q)


class Runner:
    def __init__(self, hub: Hub, detector=DEFAULT_DETECTOR):
        self.hub = hub
        self.detector = detector
        self.brain = load_brain(BRAIN_PATH)
        self.thread: threading.Thread | None = None
        self.stop = threading.Event()
        self.scan: LiveScan | None = None

    def start(self, lines, *, speed: float, medium: str, label: str, truth: dict | None = None):
        self.stop.set()
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=5)
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._run, args=(lines, speed, medium, label, truth, self.stop),
                                       daemon=True)
        self.thread.start()

    def _run(self, lines, speed, medium, label, truth, stop):
        scan = LiveScan(calibration=Calibration(detector=self.detector), prior=PRIORS[medium], paint_blood=True)
        self.scan = scan
        self.hub.last.pop("update", None)
        spots = [{"id": s.id, "side": s.side, "region": s.region,
                  "pos": _round(s.direction * HEAD_RADIUS_MM, 2)} for s in DEFAULT_SPOTS]
        self.hub.publish("hello", {"label": label, "medium": medium, "speed": speed, "plan": [s.id for s in scan.plan],
                                   "spots": spots, "head_radius": HEAD_RADIUS_MM, "truth": truth,
                                   "prevalence": scan.prevalence, "n_sims": scan.n_sims}, remember=True)
        air = deque(maxlen=800)  # recent coil levels: the top of them is the probe in air
        batch, last_flush, t0 = [], 0.0, time.monotonic()
        for line in lines:
            if stop.is_set():
                return
            frame = parse_frame(line) if isinstance(line, str) else line
            if frame is None:
                continue
            if speed > 0:
                delay = t0 + frame["t_ms"] / 1000 / speed - time.monotonic()
                if delay > 0:
                    time.sleep(delay)
            batch.append(frame)
            update = scan.feed(frame)
            now = time.monotonic()
            if update is not None or now - last_flush > 0.08:
                self._send_frames(batch, air, scan)
                batch, last_flush = [], now
            if update is not None:
                self.hub.publish("update", self._payload(scan, update), remember=True)
        if batch:
            self._send_frames(batch, air, scan)
        final = scan.finish()
        if final is not None and not stop.is_set():
            self.hub.publish("update", self._payload(scan, final), remember=True)

    def _send_frames(self, batch, air, scan):
        u = to_units(pd.DataFrame(batch, columns=list(COLUMNS)), self.detector)
        dbm = u["coil_dbm"].to_numpy()
        ref = []
        for x in dbm:
            air.append(x)
            ref.append(max(air))
        gyro = np.sqrt(u["gx_dps"] ** 2 + u["gy_dps"] ** 2 + u["gz_dps"] ** 2)
        self.hub.publish("frames", {"t": _round(u["t_s"], 2), "coil_db": _round(dbm - np.array(ref), 3),
                                    "nir": _round(u["ir_net_v"], 4), "ambient": _round(u["ir_amb_v"], 4),
                                    "motion": _round(gyro, 1), "status": scan.status()})

    def _payload(self, scan: LiveScan, u) -> dict:
        interp, loc = scan.interp, scan.location
        spots = interp.spots
        keep = [c for c in ("spot", "side", "region", "status", "sigma", "sigma_se", "gap_mm", "note", "pulse_bpm")
                if c in spots]
        spot_rows = spots[spots["spot"].isin(u.done)][keep].replace({np.nan: None}).to_dict(orient="records")
        pairs = (interp.pairs[["region", "d_sigma", "d_sigma_se", "z"]].replace({np.nan: None}).to_dict(orient="records")
                 if len(interp.pairs) else [])
        done_pairs = {r for r in [s.split("-", 1)[1] for s in u.done]
                      if f"L-{r}" in u.done and f"R-{r}" in u.done}
        pairs = [p for p in pairs if p["region"] in done_pairs]
        sims = scan.sims or {}
        cortex = np.zeros(len(self.brain), np.uint8)
        if loc is not None and loc.blood.max() > 0.02:
            hot = loc.blood > 0.02
            tree = cKDTree(loc.voxels[hot])
            dist, idx = tree.query(self.brain, k=12, distance_upper_bound=14.0)
            vals = np.concatenate([loc.blood[hot], [0.0]])[np.minimum(idx, hot.sum())]
            heat = (vals * np.exp(-((np.minimum(dist, 99) / 9.0) ** 2))).max(axis=1)
            cortex = np.clip(heat * 255, 0, 255).astype(np.uint8)
        return {
            "t_s": u.t_s, "final": u.final, "text": u.text, "p_bleed": u.p_bleed, "pairs_done": u.pairs_done,
            "done": u.done, "retake": u.retake, "confirm": u.confirm, "next_spot": u.next_spot,
            "surprises": u.surprises, "location": u.location, "spots": spot_rows, "pairs": pairs,
            "predictions": u.predictions.replace({np.nan: None}).to_dict(orient="records") if len(u.predictions) else [],
            "flag": interp.flag if u.final else None,
            "sims": {"bleed": np.asarray(sims.get("bleed", []), int).tolist(),
                     "points": _round(sims.get("points", np.zeros((0, 3))), 1),
                     "regions": sims.get("regions", []),
                     "pair_d": _round(np.asarray(sims.get("pair_d", np.zeros((0, 0)))).T, 4)},
            "voxels": loc.cloud_records(1800) if loc is not None else [],
            "cortex": base64.b64encode(cortex.tobytes()).decode(),
            "status": scan.status(),
        }


def sim_source(key: str, seed: int, artifacts: float):
    label, medium, bleeds = SCENARIOS[key]
    plan = ls.default_plan()
    if artifacts:
        plan = ls.add_random_artifacts(plan, artifacts, seed=seed)
    session = ls.simulate(ls.Subject(medium, bleeds, seed=seed), plan, seed=seed)
    truth = None
    if bleeds:
        centre, depth, thick, spread = bleeds[0].geometry(medium)
        truth = {"near_edge": _round(centre * (HEAD_RADIUS_MM - depth), 1), "normal": _round(centre, 4),
                 "thickness_mm": thick, "spread_mm": spread, "label": str(bleeds[0])}
    return ls.serial_lines(session), medium.name, label, truth


def file_lines(path: Path):
    if path.suffix == ".csv":
        df = pd.read_csv(path)
        for r in df[list(COLUMNS)].itertuples(index=False):
            yield ",".join(str(int(v)) for v in r)
    else:
        with open(path, errors="replace") as f:
            yield from f


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, app=None, **kwargs):
        self.app = app
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def log_message(self, fmt, *args):  # quiet
        pass

    def _json(self, data, code=200):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == "/events":
            return self._events()
        if url.path == "/api/scenarios":
            return self._json({"source": self.app.source, "scenarios": {k: v[0] for k, v in SCENARIOS.items()}})
        if url.path == "/api/start":
            return self._json(self.app.start(q))
        if url.path == "/api/follow":
            if self.app.runner.scan is None:
                return self._json({"ok": False}, 409)
            self.app.runner.scan.follow(q["spot"])
            return self._json({"ok": True, "plan": [s.id for s in self.app.runner.scan.plan]})
        return super().do_GET()

    def _events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        q = self.app.hub.subscribe()
        try:
            while True:
                try:
                    msg = q.get(timeout=15)
                except queue.Empty:
                    msg = ": keep-alive\n\n"
                self.wfile.write(msg.encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            self.app.hub.unsubscribe(q)


class App:
    def __init__(self, source: dict, detector):
        self.source = source
        self.hub = Hub()
        self.runner = Runner(self.hub, detector)

    def start(self, q: dict) -> dict:
        speed = float(q.get("speed", 1.0))
        if self.source["kind"] == "serial":
            lines = open(self.source["path"], errors="replace")
            self.runner.start(lines, speed=0, medium=q.get("medium", "human"), label=f"Live: {self.source['path']}")
        elif self.source["kind"] == "replay":
            path = Path(self.source["path"])
            sidecar = path.with_suffix(".json")
            medium = json.loads(sidecar.read_text()).get("medium", "human") if sidecar.exists() else "human"
            self.runner.start(file_lines(path), speed=speed, medium=medium, label=f"Recording: {path.name}")
        else:
            key = q.get("scenario", "subdural")
            seed = int(q.get("seed", 3))
            lines, medium, label, truth = sim_source(key, seed, float(q.get("artifacts", 0.2)))
            self.runner.start(lines, speed=speed, medium=medium, label=label, truth=truth)
        return {"ok": True}


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m lucid_ui", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8765)
    src = parser.add_mutually_exclusive_group()
    src.add_argument("--serial", help="serial device to read the board from")
    src.add_argument("--replay", help="a recorded .csv or .log to replay")
    parser.add_argument("--detector", choices=sorted(DETECTORS), default=DEFAULT_DETECTOR.name)
    args = parser.parse_args(argv)
    source = ({"kind": "serial", "path": args.serial} if args.serial else
              {"kind": "replay", "path": args.replay} if args.replay else {"kind": "sim"})
    app = App(source, DETECTORS[args.detector])
    server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, app=app))
    server.daemon_threads = True
    print(f"Lucid live view on http://localhost:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
