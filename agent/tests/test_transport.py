"""Transport in the pre-alert and on the call, and the recap texted after a call. No network, no model calls.

Run from agent/:  .venv/bin/python tests/test_transport.py
"""

import asyncio
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lucid import bridge, photon, tools  # noqa: E402
from test_bridge import ANSWER, FakeLG, ago, fake_photon, record  # noqa: E402
from test_photon import ENTRY, STATE, patched, photon_env, runtime, with_roster  # noqa: E402

T = {"unit": "Medic 12", "eta_min": 12, "origin": "on scene, en route", "as_of": "2026-11-14T19:00:00+00:00"}
LINE = "Medic 12, ETA about 12 min (on scene, en route)."
FINDING = "Epidural bleed, left temporal, about 25 mL."
RECAP_NONE = "No decision was recorded on our call about patient P-0042. Reply ACCEPT or DECLINE here when you can."


# ---- Lines and the pre-alert text ------------------------------------------


def test_transport_lines():
    assert photon.transport_line(T) == LINE and photon.transport_line(None) == ""
    assert photon.spoken_transport(T) == "Medic 12, about 12 minutes out" and photon.spoken_transport(None) == ""


def test_prealert_text_adds_the_transport_when_the_model_left_it_out():
    t = photon.prealert_text(FINDING + " Screening aid, not a diagnosis. Please prepare CT.", "P-0042", T)
    assert t == f"Lucid pre-alert, patient P-0042\n{FINDING}\n{LINE}\n{photon.SAFETY_LINE}\n\n{photon.REPLY_LINE}"
    assert t.lower().count("not a diagnosis") == 1


def test_prealert_text_keeps_an_eta_the_model_wrote():
    for said in ("ETA about 12 min", "about 12 minutes out", "arriving in 12 min"):
        t = photon.prealert_text(f"{FINDING} {said}.", "P-0042", T)
        assert "Medic 12" not in t and said in t, said


def test_prealert_text_without_transport_is_unchanged():
    assert photon.prealert_text(FINDING, "P-0042", None) == photon.prealert_text(FINDING, "P-0042")
    assert LINE not in photon.prealert_text(FINDING, "P-0042")


# ---- Through send_prealert -------------------------------------------------


def test_prealert_carries_the_transport_to_the_text_and_the_record():
    rt = with_roster(runtime({**STATE, "recipient": ENTRY, "reading": {"transport": T}}))
    texts = []

    async def image(*a, **kw):
        return "mi"

    async def text(space, sender, body, key):
        texts.append(body)
        return "mt"

    async def report(_path):
        return "REPORT"

    async def go():
        with patched(tools, _read_text=report), patched(photon, send_text=text, send_image=image):
            return await tools.send_prealert.coroutine(destination="x", message=FINDING, runtime=rt)

    with photon_env():
        cmd = asyncio.run(go())
    [body] = texts
    assert LINE in body and body.index(FINDING) < body.index(LINE) < body.index(photon.SAFETY_LINE)
    rec = asyncio.run(rt.store.aget(photon.HANDOFFS_NS, "t1")).value
    assert rec["transport"] == T and rec["status"] == "sent" and cmd.update["handoff"]["message"] == body


# ---- call_recap ------------------------------------------------------------


def test_call_recap_cases():
    called = ago(0)
    accept = {"decision": "accept", "note": "", "at": ago(0), "via": "call"}
    text = bridge.call_recap(record(reply=accept), called)
    assert text.startswith("From our call at ") and "you accepted patient P-0042. The medic has been told." in text
    assert text.endswith("I will text you if a re-scan changes anything.") and "Noted" not in text
    noted = bridge.call_recap(record(reply={**accept, "note": "bed 4 ready."}), called)
    assert noted.endswith("Noted: bed 4 ready.") and ".." not in noted
    assert bridge.call_recap(record(reply={**accept, "note": "bed 4 ready"}), called).endswith("Noted: bed 4 ready.")
    decline = bridge.call_recap(record(reply={**accept, "decision": "decline"}), called)
    assert "you declined patient P-0042. The medic has been told." in decline and "re-scan" not in decline
    assert bridge.call_recap(record(reply=None), called) == RECAP_NONE
    assert bridge.call_recap(record(reply={**accept, "decision": "none"}), called) == RECAP_NONE
    assert bridge.call_recap(record(reply={**accept, "via": "imessage"}), called) is None  # a text decision stands


# ---- on_no_reply end to end ------------------------------------------------


class CallLG(FakeLG):
    """A lead that, on the call run, records the clinician's decision in the Store as record_reply would, and answers with canned text."""

    def __init__(self, reply=None):
        super().__init__()
        self.reply = reply

    async def _wait(self, thread_id, assistant, input=None, metadata=None, multitask_strategy=None):
        if self.reply and (metadata or {}).get("kind") == "call":
            await bridge.update_record(self, thread_id, lambda rec: {**rec, "reply": self.reply})
        return await super()._wait(thread_id, assistant, input=input, metadata=metadata, multitask_strategy=multitask_strategy)


def call_outcome(answered=True):
    return {"answered": answered, "decision": "none", "summary": "s", "duration_s": 18 if answered else 30, "transcript": [{"role": "user", "text": "hello"}]}


def place(lg, outcome):
    async def go():
        with fake_photon(voice_enabled=True) as env, patch.object(bridge.voice, "place_call", return_value="voice-9"), patch.object(bridge.voice, "wait_for_call", return_value=outcome):
            await bridge.on_no_reply(lg.get(), lg)
        return env

    return asyncio.run(go())


def test_answered_call_texts_the_recap_not_the_leads_answer():
    for decision, via in (("accept", "call"), ("decline", "call")):
        reply = {"decision": decision, "note": "bed 4 ready", "at": ago(1), "via": via}
        lg = CallLG(reply)
        lg.put(record(sent_at=ago(120), transport=T))
        env = place(lg, call_outcome())
        [(space, agent, text, key)] = env.sends
        assert (space, agent, key) == ("space-A", "agent1", "call-recap:voice-9") and text != ANSWER
        assert f"you {decision}{'ed' if decision == 'accept' else 'd'} patient P-0042" in text and "Noted: bed 4 ready." in text
        assert ("re-scan" in text) == (decision == "accept")
        assert lg.get()["messages"] == [{"id": "sent-1", "kind": "recap", "status": "queued"}] and lg.get()["reply"] == reply


def test_answered_call_after_a_text_decision_sends_no_recap():
    lg = CallLG({"decision": "accept", "note": "", "at": ago(1), "via": "imessage"})
    lg.put(record(sent_at=ago(120)))
    env = place(lg, call_outcome())
    assert env.sends == [] and lg.get()["messages"] == []


def test_unanswered_call_logs_the_try_text_as_a_recap():
    lg = CallLG()
    lg.put(record(sent_at=ago(120)))
    env = place(lg, call_outcome(answered=False))
    [(_, _, text, key)] = env.sends
    assert text.startswith("I tried to call at ") and text.endswith("Reply ACCEPT or DECLINE.") and key == "call-no-answer:voice-9"
    assert lg.get()["messages"] == [{"id": "sent-1", "kind": "recap", "status": "queued"}] and lg.get()["call"]["status"] == "no_answer"


# ---- call_times ------------------------------------------------------------


def test_call_times():
    ended = ago(60)
    derived = bridge.call_times({"answered": True, "duration_s": 18, "ended_at": ended})
    assert derived["ended_at"] == ended and (bridge._at(ended) - bridge._at(derived["answered_at"])).total_seconds() == 18
    given = bridge.call_times({"answered": True, "duration_s": 18, "ended_at": ended, "answered_at": ago(300)})
    assert given["answered_at"] == bridge._iso(bridge._at(given["answered_at"])) and given["answered_at"] != derived["answered_at"]
    assert set(bridge.call_times(None)) == {"ended_at"}
    assert set(bridge.call_times({"answered": False, "duration_s": 30})) == {"ended_at"}
    assert abs((bridge._now() - bridge._at(bridge.call_times({"answered": True, "duration_s": 5})["ended_at"])).total_seconds()) < 5


if __name__ == "__main__":
    tests = [f for name, f in sorted(globals().items()) if name.startswith("test_")]
    for t in tests:
        t()
        print("ok ", t.__name__)
    print(len(tests), "passed")
