"""The medic's notes: the line and the spoken form, the env override, /scan.json, the hand-off record and the call variables. No network, no model calls.

Run from agent/:  .venv/bin/python tests/test_notes.py
"""

import asyncio
import importlib
import json
import os
import sys
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from langgraph.store.memory import InMemoryStore  # noqa: E402

from lucid import bridge, config, photon, tools  # noqa: E402
from test_bridge import FakeLG, ago, clinician, fake_photon, record, reply_to  # noqa: E402

N = {"age_sex": "Male, about 40", "mechanism": "Fell about 3 m from a ladder 25 minutes ago", "gcs": 13, "pupils": "equal and reactive", "bp": "152/88", "hr": 96}
T = {"unit": "Medic 12", "eta_min": 12, "origin": "on scene, en route", "as_of": "2026-11-14T19:00:00+00:00"}
LINE = "Male, about 40. Fell about 3 m from a ladder 25 minutes ago. GCS 13, pupils equal and reactive. BP 152/88, heart rate 96."
SPOKEN = "Male, about 40. Fell about 3 meters from a ladder 25 minutes ago. GCS 13, pupils equal and reactive. Blood pressure 152 over 88, heart rate 96."
ENTRY = {"handle": "+15555550142", "space_id": "sp1", "agent_user_id": "ag1", "since": "2026-11-14T10:00:00Z", "active": True}


@contextmanager
def patched(obj, **attrs):
    old = {k: getattr(obj, k) for k in attrs}
    for k, v in attrs.items():
        setattr(obj, k, v)
    try:
        yield
    finally:
        for k, v in old.items():
            setattr(obj, k, v)


@contextmanager
def photon_env(on: bool = True):
    """Set (or clear) the Photon credentials for one test, then put them back."""
    keys = ("PHOTON_PROJECT_ID", "PHOTON_API_KEY")
    saved = {k: os.environ.get(k) for k in keys}
    load, photon._load_env = photon._load_env, lambda: None
    for k in keys:
        if on:
            os.environ[k] = "dummy"
        else:
            os.environ.pop(k, None)
    try:
        yield
    finally:
        photon._load_env = load
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


# ---- The line and the spoken form ------------------------------------------


def test_notes_line():
    assert photon.notes_line(N) == LINE
    assert photon.notes_line({k: v for k, v in N.items() if k != "bp"}) == "Male, about 40. Fell about 3 m from a ladder 25 minutes ago. GCS 13, pupils equal and reactive. heart rate 96."
    assert photon.notes_line({"text": "Fell from a ladder."}) == "Fell from a ladder."
    assert photon.notes_line({"text": "Fell from a ladder.", "gcs": 14}) == "GCS 14."  # structured fields win over the text
    assert photon.notes_line(None) == "" and photon.notes_line({}) == ""


def test_spoken_notes():
    assert photon.spoken_notes(N) == SPOKEN
    assert "25 minutes" in photon.spoken_notes(N) and "25 meters" not in photon.spoken_notes(N)
    mid = photon.spoken_notes({"age_sex": "Male", "bp": "120/80"})  # BP starts its own sentence here
    assert mid == "Male. Blood pressure 120 over 80."
    assert photon.spoken_notes({"text": "Seen with BP 110/70 earlier"}) == "Seen with blood pressure 110 over 70 earlier"
    assert photon.spoken_notes(None) == ""


# ---- The env override ------------------------------------------------------


def config_with(value):
    """The notes lucid.config computes for an env value, then the module is reloaded back to the real environment."""
    saved = os.environ.get("LUCID_MEDIC_NOTES")
    try:
        if value is None:
            os.environ.pop("LUCID_MEDIC_NOTES", None)
        else:
            os.environ["LUCID_MEDIC_NOTES"] = value
        return dict(importlib.reload(config).MEDIC_NOTES)
    finally:
        if saved is None:
            os.environ.pop("LUCID_MEDIC_NOTES", None)
        else:
            os.environ["LUCID_MEDIC_NOTES"] = saved
        importlib.reload(config)


def test_env_override():
    defaults = config_with(None)
    assert defaults["gcs"] == 13 and defaults["bp"] == "152/88"
    merged = config_with('{"gcs": 9, "pupils": "fixed"}')
    assert merged == {**defaults, "gcs": 9, "pupils": "fixed"}
    assert config_with("Unconscious at the scene") == {"text": "Unconscious at the scene"}
    assert config_with("{not json") == {"text": "{not json"}
    assert config.MEDIC_NOTES == defaults  # the module is back to the real environment


# ---- read_scan -------------------------------------------------------------


def test_read_scan_publishes_the_notes():
    events, files = [], {}

    async def no_baseline(_path):
        return None

    async def write(path, content):
        files[path] = content

    async def delete(_path):
        return None

    rt = SimpleNamespace(state={"patient_id": "P-0042"}, config={"configurable": {"thread_id": "t1"}}, tool_call_id="c1", store=InMemoryStore(), stream_writer=events.append)

    async def go():
        with patched(tools, _read_json=no_baseline), patched(tools.backend, awrite=write, adelete=delete):
            return await tools.read_scan.coroutine(runtime=rt)

    cmd = asyncio.run(go())
    doc = json.loads(files[tools.SCAN_FILE])
    expected = photon.notes_line(config.MEDIC_NOTES)
    assert doc["medic_notes"]["gcs"] == 13 and doc["medic_notes"]["text"] == expected
    for where in (cmd.update["reading"], cmd.update["scan"]):
        assert where["medic_notes"]["gcs"] == 13 and where["medic_notes"]["text"] == expected and where["medic_notes"]["as_of"]
    assert "Medic's notes" in cmd.update["messages"][0].content and expected in cmd.update["messages"][0].content
    assert any(e.get("scan", {}).get("medic_notes") for e in events)


# ---- send_prealert ---------------------------------------------------------


def test_prealert_text_does_not_grow_and_the_record_keeps_the_notes():
    rt = SimpleNamespace(
        state={"scan": {"status": "bleed", "region": "L temporal", "volume_ml": 25, "map": [[0.0] * 8 for _ in range(8)]}, "patient_id": "P-0042", "recipient": ENTRY, "reading": {"transport": T, "medic_notes": {**N, "text": LINE}}},
        config={"configurable": {"thread_id": "t1"}},
        tool_call_id="c1",
        store=InMemoryStore(),
        stream_writer=[].append,
    )
    asyncio.run(rt.store.aput(photon.ONCALL_NS, ENTRY["handle"], ENTRY))
    texts = []
    message = "Epidural bleed, left temporal, about 25 mL."

    async def image(*a, **kw):
        return "mi"

    async def text(space, sender, body, key):
        texts.append(body)
        return "mt"

    async def report(_path):
        return "REPORT"

    async def go():
        with patched(tools, _read_text=report), patched(photon, send_text=text, send_image=image):
            return await tools.send_prealert.coroutine(destination="x", message=message, runtime=rt)

    with photon_env():
        asyncio.run(go())
    [body] = texts
    assert body == photon.prealert_text(message, "P-0042", T)
    assert not any(w in body for w in ("GCS", "heart rate", "ladder"))
    rec = asyncio.run(rt.store.aget(photon.HANDOFFS_NS, "t1")).value
    assert rec["medic_notes"] == {**N, "text": LINE} and rec["transport"] == T


# ---- The call variables ----------------------------------------------------


def placed_variables(rec):
    lg = FakeLG()
    lg.put(rec)
    placed = []

    def place_call(destination, variables):
        placed.append(variables)
        return "voice-9"

    outcome = {"answered": False, "decision": "none", "summary": "", "duration_s": 30, "transcript": []}

    async def go():
        with fake_photon(voice_enabled=True), patch.object(bridge.voice, "place_call", side_effect=place_call), patch.object(bridge.voice, "wait_for_call", return_value=outcome):
            await bridge.on_no_reply(lg.get(), lg)

    asyncio.run(go())
    [variables] = placed
    return variables


def test_call_variables_carry_the_spoken_notes_and_unit():
    v = placed_variables(record(sent_at=ago(120), transport=T, medic_notes=N))
    assert v["medic_notes"] == SPOKEN and v["unit"] == "Medic 12" and v["transport"] == "Medic 12, about 12 minutes out"
    bare = placed_variables(record(sent_at=ago(120)))
    assert bare["medic_notes"] == "" and bare["unit"] == "" and bare["transport"] == ""


# ---- record_reply trusts the call's decision -------------------------------


def test_call_decision_is_trusted_after_a_read_back():
    transcript = json.dumps([{"role": "assistant", "text": "To confirm, you accept patient P-0042?"}, {"role": "user", "text": "Yes."}])
    cmd, rec, events = reply_to([clinician(f"decision: accept. Summary: Confirmed on read-back. Transcript: {transcript}", via="phone call")])
    assert rec["reply"]["decision"] == "accept" and rec["reply"]["via"] == "call"
    assert cmd.update["handoff"]["reply"] == rec["reply"] and len(events) == 1


if __name__ == "__main__":
    tests = [f for name, f in sorted(globals().items()) if name.startswith("test_")]
    for t in tests:
        t()
        print("ok ", t.__name__)
    print(len(tests), "passed")
