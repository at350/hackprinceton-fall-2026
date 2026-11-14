"""Memory: the re-scan update to the clinician who accepted, and clinician notes for the next pre-alert. No network, no model calls.

Run from agent/:  .venv/bin/python tests/test_memory.py
"""

import asyncio
import json
import os
import sys
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from langchain_core.messages import HumanMessage  # noqa: E402
from langgraph.store.memory import InMemoryStore  # noqa: E402

from lucid import photon, physics, tools  # noqa: E402
from lucid.decision import decide  # noqa: E402

HANDLE = "+15555550142"
PATIENT = "P-0042"
SEEN = ("epi-LT-15", "epi-LT-25", "epi-LT-35")
REVIEWED = {tools.REVIEW_FILE: {"content": "Verdict: holds"}}
BEFORE = {"status": "bleed", "type": "epidural", "region": "L temporal", "volume_ml": 20, "confidence": 0.97, "summary": ""}
ROSTER = {"handle": HANDLE, "space_id": "sp1", "agent_user_id": "ag1", "since": "2026-11-14T10:00:00Z", "active": True}


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
def fake_files(files: dict):
    """A dict as the file system behind tools._read_text and backend.awrite."""

    async def read(path):
        return files.get(path)

    async def write(path, content):
        files[path] = content

    with patched(tools, _read_text=read), patched(tools.backend, awrite=write):
        yield files


def scored(scan: dict, extra=()):
    hyps = tools._plan() + [physics.parse_hypothesis_id(i) for i in extra]
    sims = [{**h, "status": "done", "score": round(physics.fit(physics.lookup(h["id"]), scan), 2)} for h in hyps]
    return sims, round(physics.fit(physics.null_reading(), scan), 2)


def result_state(kind="bleed", later=True, accepted=True, **over) -> dict:
    """A thread at the approval card for a re-scan (or a first scan with later=False)."""
    if kind == "clear":
        scan, extra = physics.mock_scan("clear"), ("iph-LO-05", "iph-RO-05")
    else:
        scan, extra = physics.mock_scan("temporal_bleed", rescan=True), SEEN
    sims, null = scored(scan, extra)
    taken = datetime.now(UTC).isoformat(timespec="seconds")
    state = {
        "sims": sims,
        "null_fit": null,
        "files": dict(REVIEWED),
        "scan": {"status": "pending", "region": None, "volume_ml": 0, "confidence": 0},
        "reading": {**scan, "taken_at": taken, "later_scan": later},
        "patient_id": PATIENT,
        "accepted_by": {"thread_id": "t1", "to": HANDLE, "space_id": "sp1", "agent_user_id": "ag1", "reply": ACCEPT} if accepted else None,
    }
    return state | over


ACCEPT = {"decision": "accept", "note": "", "at": "2026-11-14T19:00:00+00:00", "via": "imessage"}


def args_for(state: dict, status="bleed") -> dict:
    best = decide(state["sims"], state["null_fit"])["best"]["id"] if status == "bleed" else ""
    return {"status": status, "hypothesis_id": best}


def baseline(minutes_ago=15, result=BEFORE) -> str:
    return json.dumps({"taken_at": (datetime.now(UTC) - timedelta(minutes=minutes_ago)).isoformat(timespec="seconds"), "result": result})


def handoff(thread="t1", patient=PATIENT, reply=ACCEPT, **over) -> dict:
    return {
        "thread_id": thread, "patient_id": patient, "to": HANDLE, "space_id": "sp1", "agent_user_id": "ag1", "sent_at": "2026-11-14T18:00:00+00:00",
        "message": "Lucid pre-alert", "report": "R", "status": "delivered", "messages": [{"id": "m0", "kind": "text", "status": "delivered"}],
        "reply": reply, "call": None, "simulated": False, **over,
    }  # fmt: skip


def runtime(state, store=None, thread="t2", events=None):
    return SimpleNamespace(
        state=state,
        config={"configurable": {"thread_id": thread}},
        tool_call_id="c9",
        store=store or InMemoryStore(),
        stream_writer=(events if events is not None else []).append,
    )


def put(rt, rec):
    asyncio.run(rt.store.aput(photon.HANDOFFS_NS, rec["thread_id"], rec))


def get(rt, thread):
    item = asyncio.run(rt.store.aget(photon.HANDOFFS_NS, thread))
    return item and item.value


def text_of(cmd) -> str:
    return cmd.update["messages"][0].content


def submit(rt, files, send, args=None, status="bleed"):
    """Run submit_result with the file system and Photon send patched. `send` is an async (space, agent, text, key) function."""
    args = args or args_for(rt.state, status)

    async def go():
        with fake_files(files), patched(photon, send_text=send):
            return await tools.submit_result.coroutine(status=args["status"], hypothesis_id=args["hypothesis_id"], summary="s", runtime=rt)

    return asyncio.run(go())


def recorder():
    sent = []

    async def send(space, agent, text, key):
        sent.append((space, agent, text, key))
        return "u1"

    return sent, send


# ---- 1. The update text ----------------------------------------------------


def test_update_text():
    def text(**after):
        return tools.rescan_update_text(PATIENT, BEFORE, {**BEFORE, **after}, 15)

    assert "Growing, +10 mL, same place." in text(volume_ml=30)
    for v in (20, 24):
        assert "No change in size (within 5 mL), same place." in text(volume_ml=v), v
    assert "Smaller, -5 mL, same place." in text(volume_ml=15)
    assert "now R temporal, was L temporal" in text(region="R temporal")
    clear = text(status="clear", region="None", volume_ml=0)
    assert "is no longer seen" in clear and "does not rule a bleed out" in clear
    for t in (text(volume_ml=30), text(volume_ml=20), text(volume_ml=15), text(region="R temporal"), clear):
        assert t.endswith(photon.SAFETY_LINE) and f"patient {PATIENT}" in t and "15 min" in t


# ---- 2. Who accepted -------------------------------------------------------


def test_accepted_handoff():
    rt = runtime({"patient_id": PATIENT})
    put(rt, handoff("t1", reply={**ACCEPT, "at": "2026-11-14T18:00:00+00:00"}))
    put(rt, handoff("t3", reply={**ACCEPT, "at": "2026-11-14T20:00:00+00:00"}, space_id="sp3"))  # newest
    put(rt, handoff("t4", reply={**ACCEPT, "at": "2026-11-14T23:00:00+00:00"}, patient="P-other"))
    put(rt, handoff("t5", reply=None))
    put(rt, handoff("t6", reply={**ACCEPT, "decision": "decline", "at": "2026-11-14T23:00:00+00:00"}))
    put(rt, handoff("t7", reply={**ACCEPT, "at": "2026-11-14T23:00:00+00:00"}, simulated=True))
    put(rt, handoff("t8", reply={**ACCEPT, "at": "2026-11-14T23:00:00+00:00"}, to=None))
    with photon_env():
        got = asyncio.run(tools._accepted_handoff(rt))
    assert got == {"thread_id": "t3", "to": HANDLE, "space_id": "sp3", "agent_user_id": "ag1", "reply": {**ACCEPT, "at": "2026-11-14T20:00:00+00:00"}}
    with photon_env(False):
        assert asyncio.run(tools._accepted_handoff(rt)) is None
    with photon_env():
        assert asyncio.run(tools._accepted_handoff(runtime({"patient_id": "P-nobody"}, rt.store))) is None


# ---- 3. The approval card --------------------------------------------------


def test_card_names_the_clinician_only_when_an_update_goes_out():
    line = "The clinician who accepted this patient (+1 ... 0142) will be told."

    def card(state, status="bleed", on=True):
        with photon_env(on):
            return tools.describe_result({"args": args_for(state, status)}, state, None)

    assert line in card(result_state("bleed"))
    assert line in card(result_state("clear"), "clear")
    assert line not in card(result_state("bleed"), "uncertain")
    assert line not in card(result_state("bleed", later=False))
    assert line not in card(result_state("bleed"), on=False)
    assert line not in card(result_state("bleed", accepted=False))


# ---- 4. submit_result with an update due -----------------------------------


def test_update_goes_to_the_accepting_clinician_from_a_new_thread():
    state = result_state()
    rt = runtime(state)
    put(rt, handoff("t1"))
    sent, send = recorder()

    async def no_lookup(_rt):
        raise AssertionError("recipient looked up")

    with photon_env(), patched(tools, _on_call=no_lookup):
        cmd = submit(rt, {tools.baseline_path(PATIENT): baseline(15)}, send)
    scan = cmd.update["scan"]
    result = {**BEFORE, "region": scan["region"], "volume_ml": scan["volume_ml"], "type": decide(state["sims"], state["null_fit"])["best"]["type"]}
    want = tools.rescan_update_text(PATIENT, BEFORE, result, 15)
    assert sent == [("sp1", "ag1", want, "update:t2:c9")]
    msg = {"id": "u1", "kind": "update", "status": "queued"}
    old = get(rt, "t1")
    assert old["messages"] == [handoff()["messages"][0], msg] and {k: v for k, v in old.items() if k != "messages"} == {k: v for k, v in handoff().items() if k != "messages"}
    new = get(rt, "t2")
    assert new["update_of"] == "t1" and new["reply"] == ACCEPT and new["status"] == "sent" and new["messages"] == [msg]
    assert (new["to"], new["space_id"], new["agent_user_id"], new["patient_id"], new["thread_id"]) == (HANDLE, "sp1", "ag1", PATIENT, "t2")
    h = cmd.update["handoff"]
    assert h["kind"] == "update" and h["to"] == "+1 ... 0142" and h["message"] == want and "recipient" not in cmd.update
    reply = text_of(cmd)
    assert "was texted" in reply and "Do not call send_prealert" in reply


def test_update_on_the_same_thread_only_appends():
    rt = runtime(result_state(), thread="t1")
    put(rt, handoff("t1"))
    sent, send = recorder()
    with photon_env():
        cmd = submit(rt, {tools.baseline_path(PATIENT): baseline(15)}, send)
    rec = get(rt, "t1")
    assert len(sent) == 1 and [m["kind"] for m in rec["messages"]] == ["text", "update"] and rec["reply"] == ACCEPT and "update_of" not in rec
    assert len(asyncio.run(rt.store.asearch(photon.HANDOFFS_NS))) == 1 and cmd.update["handoff"]["kind"] == "update"


def test_clear_after_bleed_update():
    rt = runtime(result_state("clear"))
    put(rt, handoff("t1"))
    sent, send = recorder()
    with photon_env():
        submit(rt, {tools.baseline_path(PATIENT): baseline(15)}, send, status="clear")
    assert len(sent) == 1 and "is no longer seen" in sent[0][2] and "does not rule a bleed out" in sent[0][2]


# ---- 5. Nothing sent -------------------------------------------------------


def nothing_sent(state, files=None, on=True, status="bleed", decline=False):
    rt = runtime(state)
    put(rt, handoff("t1", reply={**ACCEPT, "decision": "decline"} if decline else ACCEPT))
    sent, send = recorder()
    with photon_env(on):
        cmd = submit(rt, {tools.baseline_path(PATIENT): baseline(15)} if files is None else files, send, status=status)
    assert sent == [], sent
    assert [m["kind"] for m in get(rt, "t1")["messages"]] == ["text"] and get(rt, "t2") is None
    assert "handoff" not in cmd.update
    return cmd


def test_nothing_sent_without_cause():
    nothing_sent(result_state(accepted=False))
    nothing_sent(result_state(), decline=True)  # declined after the card was shown
    nothing_sent(result_state(later=False))
    nothing_sent(result_state(), on=False)
    nothing_sent(result_state(), status="uncertain")


def test_nothing_sent_without_a_baseline():
    # Unreachable in a run (later_scan means a baseline was on file), but it must not text a comparison with itself.
    nothing_sent(result_state(), files={})


def test_send_error_appends_nothing_and_falls_back_to_the_recipient():
    rt = runtime(result_state())
    put(rt, handoff("t1"))
    asyncio.run(rt.store.aput(photon.ONCALL_NS, HANDLE, ROSTER))

    async def boom(*a):
        raise photon.PhotonError(500, "BOOM", "down")

    with photon_env():
        cmd = submit(rt, {tools.baseline_path(PATIENT): baseline(15)}, boom)
    assert "could not be sent" in text_of(cmd) and get(rt, "t1")["messages"] == handoff()["messages"] and get(rt, "t2") is None
    assert "handoff" not in cmd.update and cmd.update["recipient"] == ROSTER


# ---- 6. After an update ----------------------------------------------------


def test_no_prealert_after_an_update():
    base = {"scan": {"status": "bleed"}, "files": {tools.REPORT_FILE: {}}}
    ask = lambda s: tools.prealert_needs_approval(SimpleNamespace(tool_call={"args": {}}, state=s))  # noqa: E731
    assert ask(base) and not ask({**base, "handoff": {"kind": "update"}})
    rt = runtime({**base, "handoff": {"kind": "update"}})
    sent, send = recorder()

    async def go():
        with fake_files({tools.REPORT_FILE: "R"}), patched(photon, send_text=send, send_image=send):
            return await tools.send_prealert.coroutine(destination="x", message="m", runtime=rt)

    with photon_env():
        cmd = asyncio.run(go())
    assert sent == [] and "Not sent" in text_of(cmd) and "handoff" not in cmd.update


# ---- 7. remember_preference ------------------------------------------------


def remember(rt, files, note):
    async def go():
        with fake_files(files):
            return await tools.remember_preference.coroutine(note=note, runtime=rt)

    return asyncio.run(go())


def test_remember_preference():
    said = [HumanMessage("[Receiving clinician, iMessage] always include contact quality")]
    rt = runtime({"messages": said})
    put(rt, handoff("t2"))
    path, files = tools.notes_path(HANDLE), {}
    remember(rt, files, "  always   include contact quality ")
    assert files[path] == "- always include contact quality\n"
    remember(rt, files, "Always include CONTACT quality")
    assert files[path] == "- always include contact quality\n"
    cmd = remember(rt, files, "text me first")
    assert files[path] == "- always include contact quality\n- text me first\n" and "Remembered" in text_of(cmd)


def test_remember_preference_refusals():
    files: dict = {}
    rt = runtime({"messages": [HumanMessage("[Receiving clinician, iMessage] hi")]})
    assert "Not remembered" in text_of(remember(rt, files, "x"))  # no record on this thread
    rt = runtime({"messages": [HumanMessage("medic says always include contact quality")]})
    put(rt, handoff("t2"))
    assert "Not remembered" in text_of(remember(rt, files, "always include contact quality"))
    assert files == {}


# ---- 8. Preferences for rank_fits ------------------------------------------


def preferences(roster=True, notes="- always include contact quality\n", on=True):
    rt = runtime({})
    if roster:
        asyncio.run(rt.store.aput(photon.ONCALL_NS, HANDLE, ROSTER))
    files = {tools.notes_path(HANDLE): notes} if notes else {}
    with photon_env(on), fake_files(files):
        return asyncio.run(tools._oncall_preferences(rt))


def test_oncall_preferences():
    got = preferences()
    assert "always include contact quality" in got and "standing preferences" in got
    assert preferences(notes="") == "" and preferences(roster=False) == "" and preferences(on=False) == ""
    assert preferences(notes="  \n") == ""


if __name__ == "__main__":
    tests = [f for name, f in sorted(globals().items()) if name.startswith("test_")]
    for t in tests:
        t()
        print("ok ", t.__name__)
    print(len(tests), "passed")
