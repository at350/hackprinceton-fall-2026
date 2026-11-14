import base64
import json

from lucid_sim.hardware import DEFAULT_DETECTOR
from lucid_ui.make_brain import load
from lucid_ui.server import SCENARIOS, App


def test_brain_fits_inside_the_skull():
    v = load()
    assert len(v) == 20484
    assert (abs(v).max(axis=0) < 78).all()


def test_simulated_scan_streams_frames_and_updates():
    app = App({"kind": "sim"}, DEFAULT_DETECTOR)
    q = app.hub.subscribe()
    app.start({"scenario": "subdural", "speed": "0", "seed": "3"})
    app.runner.thread.join(timeout=120)
    events = []
    while not q.empty():
        msg = q.get()
        events.append((msg.split("\n")[0][7:], json.loads(msg.split("data: ", 1)[1])))
    kinds = [k for k, _ in events]
    assert kinds[0] == "hello" and kinds.count("update") >= 8 and "frames" in kinds
    hello = events[0][1]
    assert hello["truth"]["label"].startswith("30 ml subdural") and len(hello["spots"]) == 10
    final = [d for k, d in events if k == "update"][-1]
    assert final["final"] and final["p_bleed"] > 0.9 and final["location"]["side"] == "L"
    assert len(final["sims"]["bleed"]) == 500 and len(final["sims"]["pair_d"]) == 5
    assert len(base64.b64decode(final["cortex"])) == 20484 and final["voxels"]
    tiles = final["tiles"]
    assert len(tiles) == 16 and all(t["bleed"] == bool(b) for t, b in zip(tiles, final["sims"]["bleed"]))
    assert all(len(base64.b64decode(t["cortex"])) == 20484 for t in tiles if t["bleed"])


def test_events_are_strict_json():
    from lucid_ui.server import Hub

    hub = Hub()
    q = hub.subscribe()
    hub.publish("update", {"flag": {"heart_rate_bpm": float("nan")}, "x": [1.0, float("inf")]})
    data = json.loads(q.get().split("data: ", 1)[1])
    assert data == {"flag": {"heart_rate_bpm": None}, "x": [1.0, None]}


def test_every_scenario_builds():
    from lucid_ui.server import sim_source

    for key in SCENARIOS:
        lines, medium, label, truth = sim_source(key, 0, 0.2)
        assert lines and medium in ("human", "phantom")
