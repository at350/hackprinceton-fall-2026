"""Photon pre-alert: request bodies, the on-call roster, the HTTP layer and the hand-off fallbacks. No network, no model calls.

Run from agent/:  .venv/bin/python tests/test_photon.py
"""

import asyncio
import io
import json
import os
import sys
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402
import numpy as np  # noqa: E402
from langgraph.store.memory import InMemoryStore  # noqa: E402
from PIL import Image  # noqa: E402

from lucid import photon, physics, tools  # noqa: E402

PHONE = "+15555550142"
ENTRY = {"handle": PHONE, "space_id": "sp1", "agent_user_id": "ag1", "since": "2026-11-14T10:00:00Z", "active": True}
STATE = {"scan": {"status": "bleed", "region": "L temporal", "volume_ml": 25, "map": [[0.0] * 8 for _ in range(8)]}, "patient_id": "P-0042"}


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


async def no_sleep(_s):
    return None


def msg(mid, created, text, handle="+15550001", content_type="text", kind="human"):
    content = {"type": content_type, "format": "plain", "text": text} if content_type == "text" else {"type": content_type}
    return {
        "id": mid,
        "createdAt": created,
        "content": content,
        "sentBy": {"id": f"u-{handle}", "kind": kind, "handle": handle},
        "receivedBy": {"id": "agent1", "kind": "agent", "handle": "lucid"},
        "space": {"id": f"space-{handle}", "kind": "direct"},
    }


# ---- Request bodies --------------------------------------------------------


def test_request_bodies():
    assert photon.text_body("s", "u", "hi") == {"spaceId": "s", "senderId": "u", "content": {"type": "text", "format": "plain", "text": "hi"}}
    assert photon.attachment_body("s", "u", "a1") == {"spaceId": "s", "senderId": "u", "content": {"type": "attachment", "attachmentId": "a1"}}


def test_multipart_two_parts_and_idempotent():
    data = b"\x89PNG-fake-bytes"
    body, ctype = photon.multipart(data, "m.png")
    assert ctype.startswith("multipart/related; boundary=") and ctype.count(";") == 1 and "type=" not in ctype
    boundary = ctype.split("boundary=")[1]
    parts = body.split(f"--{boundary}".encode())
    assert parts[0] == b"" and parts[-1] == b"--\r\n" and len(parts) == 4  # two parts between the delimiters
    head, _, meta = parts[1].partition(b"\r\n\r\n")
    assert head == b"\r\nContent-Type: application/json"
    assert json.loads(meta.rstrip(b"\r\n")) == {"contentType": "image/png", "sizeBytes": len(data), "filename": "m.png"}
    _, _, raw = parts[2].partition(b"\r\n\r\n")
    assert raw == data + b"\r\n"
    assert photon.multipart(data, "m.png") == (body, ctype)  # a retry sends the same request


# ---- Text ------------------------------------------------------------------


def test_prealert_text_shape():
    t = photon.prealert_text("Epidural bleed, left temporal, about 25 mL.", "P-0042")
    assert t == f"Lucid pre-alert, patient P-0042\nEpidural bleed, left temporal, about 25 mL.\n{photon.SAFETY_LINE}\n\n{photon.REPLY_LINE}"


def test_prealert_text_replaces_model_safety_line():
    t = photon.prealert_text("Bleed, left temporal. Screening aid, not a diagnosis. Please prepare CT.", "P-1")
    assert t.lower().count("screening aid") == 1 and "Please prepare" not in t
    assert t.endswith(f"{photon.SAFETY_LINE}\n\n{photon.REPLY_LINE}")


def test_prealert_text_patient_once_and_no_double_header():
    t = photon.prealert_text("Pre-alert, patient P-0042: bleed on the left.", "P-0042")
    assert t.count("P-0042") == 1 and t.count("re-alert") == 1, t
    assert t.splitlines()[0] == "Lucid pre-alert" and t.splitlines()[1].startswith("Patient P-0042")


# ---- Roster ----------------------------------------------------------------


def test_roster_command():
    for text in ("On call", " on call ", "ON-CALL", "oncall", "On call."):
        assert photon.roster_command(text) == "on", text
    for text in ("off", "Off call"):
        assert photon.roster_command(text) == "off", text
    for text in ("ok", "", None):
        assert photon.roster_command(text) is None, text


def test_roster_changes_latest_wins():
    msgs = [
        msg("1", "2026-11-14T09:00:00Z", "on call", "+1555A"),
        msg("2", "2026-11-14T09:05:00Z", "thanks!", "+1555A"),
        msg("3", "2026-11-14T09:10:00Z", "off", "+1555A"),
        msg("4", "2026-11-14T09:20:00Z", "on call", "+1555B"),
        msg("5", "2026-11-14T09:30:00Z", "on call", "+1555C", content_type="attachment"),
        msg("6", "2026-11-14T09:31:00Z", "on call", "lucid", kind="agent"),
    ]
    got = {e["handle"]: e for e in photon.roster_changes(msgs)}
    assert set(got) == {"+1555A", "+1555B"}
    assert got["+1555A"] == {"handle": "+1555A", "space_id": "space-+1555A", "agent_user_id": "agent1", "since": "2026-11-14T09:10:00Z", "active": False}
    assert got["+1555B"]["active"] is True and got["+1555B"]["since"] == "2026-11-14T09:20:00Z"
    # A later unrelated text leaves the last command in force.
    assert photon.roster_changes(msgs[:1] + [msg("9", "2026-11-14T10:00:00Z", "ok", "+1555A")])[0]["active"] is True


def test_pick_oncall():
    a = {**ENTRY, "handle": "a", "since": "2026-11-14T08:00:00Z"}
    b = {**ENTRY, "handle": "b", "since": "2026-11-14T09:00:00Z"}
    c = {**ENTRY, "handle": "c", "since": "2026-11-14T11:00:00Z", "active": False}
    assert photon.pick_oncall([a, b, c]) is b
    assert photon.pick_oncall([c]) is None and photon.pick_oncall([]) is None


class FakeStore:
    def __init__(self, items=()):
        self.items = {i["handle"]: i for i in items}

    async def search_items(self, ns, limit=100):
        return {"items": [{"value": v} for v in self.items.values()]}

    async def put_item(self, ns, key, value):
        self.items[key] = value


def test_apply_roster_skips_older_change():
    async def go():
        lg = SimpleNamespace(store=FakeStore([{**ENTRY, "handle": "+1555A", "since": "2026-11-14T12:00:00Z"}]))
        written = await photon.apply_roster(lg, [msg("1", "2026-11-14T09:00:00Z", "off", "+1555A"), msg("2", "2026-11-14T09:00:00Z", "on call", "+1555B")])
        assert [e["handle"] for e in written] == ["+1555B"]
        assert lg.store.items["+1555A"]["active"] is True and lg.store.items["+1555B"]["active"] is True

    asyncio.run(go())


def test_mask():
    assert photon.mask("+15555550142") == "+1 ... 0142"
    assert photon.mask(None) == "nobody"


# ---- HTTP layer ------------------------------------------------------------


def test_send_text_posts_message_with_key():
    calls = []

    async def fake_call(method, path, **kw):
        calls.append((method, path, kw))
        return {"id": "m1"}

    async def go():
        with patched(photon, _call=fake_call):
            assert await photon.send_text("s", "u", "hello", "k1") == "m1"

    asyncio.run(go())
    [(method, path, kw)] = calls
    assert (method, path) == ("POST", "/messages")
    assert kw["json"] == photon.text_body("s", "u", "hello") and kw["headers"] == {"idempotency-key": "k1"}


def test_send_image_uploads_then_sends_and_retries_not_ready():
    calls, sends = [], []

    async def fake_call(method, path, **kw):
        calls.append((path, kw))
        if path == "/attachments":
            return {"id": "att1"}
        sends.append(1)
        if len(sends) == 1:
            raise photon.PhotonError(409, "ATTACHMENT_NOT_READY")
        return {"id": "m9"}

    async def go():
        with patched(photon, _call=fake_call, asyncio=SimpleNamespace(sleep=no_sleep)):
            return await photon.send_image("s", "u", b"pngbytes", "m.png", "K")

    assert asyncio.run(go()) == "m9"
    upload = calls[0][1]
    body, ctype = photon.multipart(b"pngbytes", "m.png")
    assert calls[0][0] == "/attachments" and upload["content"] == body
    assert upload["headers"] == {"content-type": ctype, "content-length": str(len(body)), "idempotency-key": "K:upload"}
    msgs = [kw for p, kw in calls if p == "/messages"]
    assert len(msgs) == 2  # the first said not ready, the second went through
    assert all(kw["json"] == photon.attachment_body("s", "u", "att1") and kw["headers"] == {"idempotency-key": "K"} for kw in msgs)


def _with_transport(handler):
    """Make photon._call talk to `handler` instead of the network."""
    real = httpx.AsyncClient
    return patched(httpx, AsyncClient=lambda **kw: real(transport=httpx.MockTransport(handler), **kw))


def test_call_waits_out_429_retry_after():
    seen, slept = [], []

    def handler(request):
        seen.append(request)
        if len(seen) == 1:
            return httpx.Response(429, headers={"retry-after": "2"}, json={"code": "RATE_LIMITED"})
        return httpx.Response(202, json={"id": "ok"})

    async def sleep(s):
        slept.append(s)

    async def go():
        with photon_env(), _with_transport(handler), patched(photon, asyncio=SimpleNamespace(sleep=sleep)):
            return await photon._call("POST", "/messages", json={"a": 1})

    assert asyncio.run(go()) == {"id": "ok"}
    assert slept == [2.0] and len(seen) == 2
    assert seen[0].headers["authorization"] == "Bearer dummy" and "/v1/projects/dummy/messages" in str(seen[0].url)


def test_call_raises_photon_error_with_code():
    def handler(request):
        return httpx.Response(400, json={"code": "BAD", "detail": "nope"})

    async def go():
        with photon_env(), _with_transport(handler):
            await photon._call("GET", "/x")

    try:
        asyncio.run(go())
    except photon.PhotonError as e:
        assert (e.status, e.code, e.detail) == (400, "BAD", "nope")
    else:
        raise AssertionError("no PhotonError")


def test_set_typing_false_when_unavailable():
    async def unavailable(*a, **kw):
        raise photon.PhotonError(422, "OPERATION_UNAVAILABLE")

    async def ok(*a, **kw):
        return {}

    async def go():
        with patched(photon, _call=unavailable):
            assert await photon.set_typing("s", "u", True) is False
        with patched(photon, _call=ok):
            assert await photon.set_typing("s", "u", True) is True

    asyncio.run(go())


# ---- send_prealert and its fallbacks ---------------------------------------


def runtime(state=None, store=None, events=None):
    events = events if events is not None else []
    return SimpleNamespace(
        state=STATE if state is None else state,
        config={"configurable": {"thread_id": "t1"}},
        tool_call_id="c1",
        store=store or InMemoryStore(),
        stream_writer=events.append,
    )


def run_send(rt, **patches):
    async def report(_path):
        return "REPORT"

    async def go():
        with patched(tools, _read_text=report):
            with patched(photon, **patches):
                return await tools.send_prealert.coroutine(destination="the on-call clinician", message="Bleed, left temporal.", runtime=rt)

    return asyncio.run(go())


def reply_of(cmd):
    return cmd.update["messages"][0].content


def stored(rt):
    item = asyncio.run(rt.store.aget(photon.HANDOFFS_NS, "t1"))
    return item and item.value


def with_roster(rt, entry=ENTRY):
    asyncio.run(rt.store.aput(photon.ONCALL_NS, entry["handle"], entry))
    return rt


def test_prealert_simulated_without_photon():
    events = []
    rt = runtime(events=events)
    with photon_env(False):
        cmd = run_send(rt)
    h = cmd.update["handoff"]
    assert set(h) == {"to", "message", "report", "sent_at", "simulated"} and h["simulated"] is True
    assert h["to"] == "the on-call clinician" and h["report"] == "REPORT"
    assert stored(rt) is None and events == [{"type": "handoff", "handoff": h}]


def test_prealert_no_one_on_call():
    for state, entry in (
        ({**STATE}, None),  # no recipient in state
        ({**STATE, "recipient": ENTRY}, {**ENTRY, "active": False}),  # went off call since the card
    ):
        rt = runtime(state)
        if entry:
            with_roster(rt, entry)
        sent = []

        async def boom(*a, **kw):
            sent.append(a)
            return "x"

        with photon_env():
            cmd = run_send(rt, send_text=boom, send_image=boom)
        assert sent == []
        rec = stored(rt)
        assert rec["status"] == "no_one_on_call" and rec["messages"] == []
        assert "nobody is on call" in reply_of(cmd) and "radio" in reply_of(cmd)
        assert cmd.update["handoff"]["status"] == "no_one_on_call" and cmd.update["handoff"]["to"] is None


def test_prealert_send_failure_recorded():
    rt = with_roster(runtime({**STATE, "recipient": ENTRY}))

    async def image(*a, **kw):
        return "i1"

    async def text(*a, **kw):
        raise photon.PhotonError(500, "BOOM", "down")

    with photon_env():
        cmd = run_send(rt, send_text=text, send_image=image)
    rec = stored(rt)
    assert rec["status"] == "failed" and "BOOM" in rec["error"]
    assert cmd.update["handoff"]["status"] == "failed" and "radio" in reply_of(cmd)


def test_prealert_happy_path():
    events, calls = [], []
    rt = with_roster(runtime({**STATE, "recipient": ENTRY}, events=events))

    async def image(space, sender, png, filename, key):
        calls.append(("image", space, sender, key, png[:4]))
        return "mi"

    async def text(space, sender, body, key):
        calls.append(("text", space, sender, key, body))
        return "mt"

    with photon_env():
        cmd = run_send(rt, send_text=text, send_image=image)
    assert [c[0] for c in calls] == ["image", "text"]
    assert calls[0][1:4] == ("sp1", "ag1", "prealert:t1:c1:image") and calls[0][4] == b"\x89PNG"
    assert calls[1][1:4] == ("sp1", "ag1", "prealert:t1:c1:text") and calls[1][4].endswith(photon.REPLY_LINE)
    rec = stored(rt)
    assert rec["status"] == "sent" and rec["to"] == PHONE and rec["message"] == calls[1][4]
    assert rec["messages"] == [{"id": "mi", "kind": "image", "status": "queued"}, {"id": "mt", "kind": "text", "status": "queued"}]
    h = cmd.update["handoff"]
    assert (h["to"], h["channel"], h["status"], h["simulated"], h["reply"]) == ("+1 ... 0142", "imessage", "sent", False, None)
    assert [e["type"] for e in events] == ["handoff"] and events[0]["handoff"] == h
    assert PHONE not in reply_of(cmd)


def test_prealert_image_failure_still_sends_text():
    rt = with_roster(runtime({**STATE, "recipient": ENTRY}))

    async def image(*a, **kw):
        raise photon.PhotonError(500, "IMG")

    async def text(*a, **kw):
        return "mt"

    with photon_env():
        cmd = run_send(rt, send_text=text, send_image=image)
    rec = stored(rt)
    assert rec["status"] == "sent" and rec["messages"] == [{"id": "mt", "kind": "text", "status": "queued"}]
    assert "could not be sent" in reply_of(cmd) and "map image and" not in reply_of(cmd)


def test_describe_prealert():
    call = {"args": {"destination": "the receiving trauma center"}}
    with photon_env(False):
        assert tools.describe_prealert(call, STATE, None).startswith("Send pre-alert to the receiving trauma center?")
    with photon_env():
        text = tools.describe_prealert(call, {**STATE, "recipient": ENTRY}, None)
        assert "on-call clinician (+1 ... 0142) by iMessage" in text
        none = tools.describe_prealert(call, STATE, None)
        assert "Nobody is on call" in none and "no pre-alert will be sent" in none


# ---- Map image -------------------------------------------------------------


def test_map_png():
    grid = np.zeros((64, 64))
    grid[20:30, 10:20] = 0.9
    png = physics.map_png(grid)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    img = Image.open(io.BytesIO(png))
    assert img.format == "PNG" and img.size == (1080, 1350), img.size


if __name__ == "__main__":
    tests = [f for name, f in sorted(globals().items()) if name.startswith("test_")]
    for t in tests:
        t()
        print("ok ", t.__name__)
    print(len(tests), "passed")
