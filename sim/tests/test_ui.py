import base64
import json
import threading

import pytest

from lucid_sim.hardware import DEFAULT_DETECTOR
from lucid_ui.make_brain import load
from lucid_ui.server import SCENARIOS, App, _clean, sim_source


def test_brain_fits_inside_the_skull():
    v = load()
    assert len(v) == 20484
    assert (abs(v).max(axis=0) < 78).all()


def test_brain_has_smooth_stages_for_the_model_view():
    from lucid_ui.make_brain import OUT

    data = json.loads(OUT.read_text())
    for side in ("left", "right"):
        h = data[side]
        assert len(h["inflated"]) == len(h["blob"]) == len(h["vertices"])


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


def test_race_data_is_complete():
    from lucid_ui.make_race import OUT

    race = json.loads(OUT.read_text())
    assert race["patients"] and all(len(p["curve"]) == 11 for p in race["patients"])
    assert any(p["bleed"] for p in race["patients"]) and any(not p["bleed"] for p in race["patients"])


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


def test_gemini_context_has_the_scan_numbers_not_the_drawing_arrays():
    from lucid_ui import gemini
    from lucid_ui.server import App, outlook_payload

    app = App({"kind": "sim"}, DEFAULT_DETECTOR)
    lines, medium, label, truth = sim_source("epidural", 3, 0.0)
    app.runner._run(lines, 0, medium, label, truth, threading.Event())
    u = app.runner.update
    assert u["final"]
    out = outlook_payload({}, app.runner.scan.location.summary)
    ctx = gemini.scan_context(app.runner.hello, u, out, "simulated head")
    text = json.dumps(_clean(ctx), allow_nan=False)
    assert ctx["chance_of_bleed"] == u["p_bleed"] and ctx["progress"]["finished"]
    assert "voxels" not in text and "cortex" not in text and "points" not in text
    assert ctx["what_if_progression"]["lanes"][0]["volume_ml_at_end"]["mean"] > 0
    assert len(text) < 30_000  # a prompt, not a data dump


def test_gemini_call_and_model_fallback(monkeypatch):
    import io
    import urllib.error
    from lucid_ui import gemini

    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setenv("GEMINI_MODEL", "gone-model")
    sent = []

    def post(url, body):
        sent.append((url, body))
        if "gone-model" in url:
            raise urllib.error.HTTPError(url, 404, "not found", {}, io.BytesIO(b"{}"))
        return {"candidates": [{"content": {"parts": [{"text": "Finding: 97% chance of bleed."}]}}]}

    monkeypatch.setattr(gemini, "_post", post)
    monkeypatch.setattr(gemini, "_get", lambda url: {"models": [
        {"name": "models/text-embedding-9", "supportedGenerationMethods": ["embedContent"]},
        {"name": "models/gemini-9-flash", "supportedGenerationMethods": ["generateContent"]}]})
    g = gemini.Gemini()
    r = g.ask({"source": "simulated head"}, "Where is it?", [{"role": "model", "text": "earlier"}])
    assert r == {"text": "Finding: 97% chance of bleed.", "model": "gemini-9-flash"}
    body = sent[-1][1]
    assert body["contents"][-1]["parts"][0]["text"] == "Where is it?"
    assert body["contents"][-1]["role"] == "user"


def test_gemini_without_a_key_says_how_to_turn_it_on(monkeypatch, tmp_path):
    from lucid_ui import gemini

    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setattr(gemini, "ENV_FILE", tmp_path / ".env")
    with pytest.raises(gemini.GeminiError, match="GEMINI_API_KEY"):
        gemini.Gemini().ask({}, None)
