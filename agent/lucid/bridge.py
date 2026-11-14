"""The Photon bridge: iMessage in and out of the scan thread, as its own long-running process.

    cd agent && .venv/bin/python -m lucid.bridge

Every 2 s it reads new texts to the Photon line. "On call" and "off" change the roster
in code. Any other text from the clinician a pre-alert went to becomes a tagged message
on that scan's thread; the triage lead answers from the scan's own data and the answer
is texted back. Nobody else gets case content. It also follows delivery of each pre-alert
and tells the medic, through the thread, when one failed or met silence.

A bridge run never resumes or rejects the medic's approval card: while the thread is
paused it waits, and the clinician is told the medic is deciding.
"""

import asyncio
import logging
import json
import os
import re
import weakref
from datetime import UTC, datetime, timedelta
from time import monotonic
from uuid import uuid4

from langgraph_sdk.errors import ConflictError

from lucid import photon, voice

log = logging.getLogger("lucid.bridge")

ASSISTANT = "lucid"
POLL_S = 2.0
BRIDGE_NS = ("lucid", "bridge")
OVERLAP_S = 60  # Photon's list is eventually consistent: re-read a minute back and skip what was handled
HANDLED_KEEP_S = 600
TRACK_FOR_S = 1800  # follow delivery, and listen for silence, this long after a pre-alert
OPEN_FOR_S = 12 * 3600  # a clinician may text about a hand-off this long after it went out
WAIT_FOR_IDLE_S = 900

CLINICIAN_TAG = "[Receiving clinician, iMessage]"
CALL_TAG = "[Receiving clinician, phone call]"
CHANNEL_TAG = "[Hand-off channel]"
ON_CALL_REPLY = "You are on call for Lucid pre-alerts until you text OFF. I only message when a medic approves a hand-off."
OFF_REPLY = "You are off call for Lucid pre-alerts. Text ON CALL to receive them again."
NO_HANDOFF_REPLY = "No hand-off is open for you. Text ON CALL to receive pre-alerts."
PAUSED_REPLY = "The medic is deciding. I will reply shortly."
# Photon's statuses for a sent message, as the hand-off record names them. 202 is queued; only delivered is delivered.
DELIVERY = {"dispatched": "queued", "accepted": "queued", "delivered": "delivered", "read": "read", "failed": "failed"}
_locks: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock]" = weakref.WeakKeyDictionary()
_FINDING = re.compile(r"\b(\d+\s?ml|fit|bleed|epidural|subdural|intraparenchymal|ha?ematoma|volume)\b", re.I)


def _record_lock() -> asyncio.Lock:
    """One lock per event loop: the voice module may call the helpers below from a loop of its own."""
    return _locks.setdefault(asyncio.get_running_loop(), asyncio.Lock())


def call_after_s() -> float:
    """Silence before the hook fires. Read when used: the bridge loads ../.env after import."""
    return float(os.getenv("LUCID_CALL_AFTER_S", "60"))


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(t: datetime) -> str:
    return t.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _at(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _age_s(s: str | None) -> float:
    return (_now() - _at(s)).total_seconds() if s else float("inf")


def tagged(tag: str, text: str) -> str:
    return f"{tag} {text.strip()}"


def with_safety_line(text: str) -> str:
    """Every text that states a finding ends with the safety line, whatever the model wrote."""
    text = text.strip()
    if _FINDING.search(text) and "not a diagnosis" not in text.lower():
        text += f"\n{photon.SAFETY_LINE}"
    return text


def ai_text(message: dict) -> str:
    c = message.get("content")
    if isinstance(c, str):
        return c.strip()
    return " ".join(b.get("text", "") for b in c or [] if isinstance(b, dict) and b.get("type") == "text").strip()


def answer_after(values: dict, message_id: str) -> str:
    """The lead's last text after the human message with this id ("" if it wrote none)."""
    messages = (values or {}).get("messages") or []
    at = next((i for i, m in enumerate(messages) if m.get("id") == message_id), None)
    if at is None:
        return ""
    texts = [ai_text(m) for m in messages[at + 1 :] if m.get("type") == "ai"]
    return next((t for t in reversed(texts) if t), "")


def delivery_update(record: dict, statuses: dict[str, str], delivered_at: dict[str, str] | None = None) -> dict:
    """The record with Photon's message statuses applied. The top-level status follows the text: the image alone failing is not a failed hand-off.
    A re-scan's record carries only the update, so there it follows the update.
    Once that message is delivered the record gets `delivered_at`: Photon's deliveredAt for it if known, else now."""
    messages = [{**m, "status": DELIVERY.get(statuses.get(m["id"], ""), m["status"])} for m in record.get("messages") or []]
    text = next((m for m in messages if m["kind"] == "text"), None) or next((m for m in messages if m["kind"] == "update"), None)
    status = record["status"]
    if text and text["status"] in ("delivered", "read", "failed"):
        status = text["status"]
    out = {**record, "messages": messages, "status": status}
    if text and text["status"] in ("delivered", "read") and not record.get("delivered_at"):
        out["delivered_at"] = (delivered_at or {}).get(text["id"]) or _iso(_now())
    return out


# ---- Helpers the voice module uses too ------------------------------------


async def run_on_thread(lg, thread_id: str, content: str, kind: str, timeout_s: float = WAIT_FOR_IDLE_S) -> str:
    """Put one tagged human message on the scan thread, run the lead, and return its last text ("" if none).

    `kind` is "clinician", "call" or "channel"; every run carries metadata {"source": "photon-bridge", "kind"} so the
    dashboard can tell it from a medic's. Waits while the thread is busy or paused at an approval card, so a bridge run
    never resumes or rejects the medic's decision.
    """
    message_id = f"bridge-{uuid4()}"
    deadline = monotonic() + timeout_s
    while True:
        thread = await lg.threads.get(thread_id)
        if thread["status"] in ("idle", "error"):
            try:
                values = await lg.runs.wait(
                    thread_id,
                    ASSISTANT,
                    input={"messages": [{"type": "human", "content": content, "id": message_id}]},
                    metadata={"source": "photon-bridge", "kind": kind},
                    multitask_strategy="reject",  # a run the dashboard started in the meantime goes first
                )
                return answer_after(values, message_id)
            except ConflictError:
                pass
        if monotonic() > deadline:
            raise TimeoutError(f"thread {thread_id} stayed {thread['status']} for {timeout_s:.0f} s")
        await asyncio.sleep(POLL_S)


async def send_to_clinician(record: dict, text: str, key: str) -> str | None:
    """Text the clinician of this hand-off, in its space, from its agent line. Returns the message id; None for an empty text."""
    if not text.strip():
        return None
    return await photon.send_text(record["space_id"], record["agent_user_id"], with_safety_line(text), key)


async def update_record(lg, thread_id: str, change) -> dict | None:
    """Read the hand-off record fresh, apply `change(record) -> record`, write it back. Keeps the window against
    the tools' own writes (record_reply) as small as a read and a write; the lock stops this process's tasks overwriting each other."""
    async with _record_lock():
        item = await lg.store.get_item(list(photon.HANDOFFS_NS), key=thread_id)
        if not item:
            return None
        new = change(item["value"])
        if new != item["value"]:
            await lg.store.put_item(list(photon.HANDOFFS_NS), key=thread_id, value=new)
        return new


async def handoffs(lg) -> list[dict]:
    return [i["value"] for i in (await lg.store.search_items(list(photon.HANDOFFS_NS), limit=100))["items"]]


# ---- Silence ---------------------------------------------------------------


def _phone_number(handle: str | None) -> bool:
    return bool(handle and re.fullmatch(r"\+[1-9]\d{7,14}", handle))


def _evidence(values: dict) -> str:
    """The best completed simulation in each region, without bulky maps or readings."""
    best = {}
    for sim in values.get("sims") or []:
        region, score = sim.get("region"), sim.get("score")
        if sim.get("status") != "done" or not region or not isinstance(score, (int, float)):
            continue
        if region not in best or score > best[region]["score"]:
            best[region] = {k: sim[k] for k in ("id", "type", "region", "volume_ml", "score") if k in sim}
    return json.dumps({"best_by_region": list(best.values()), "no_bleed_fit": values.get("null_fit")})


def _call_change(record: dict, **change) -> dict:
    return {**record, "call": {**(record.get("call") or {}), **change}}


async def on_no_reply(record: dict, lg) -> None:
    """Escalate once, without blocking the bridge's text polling."""
    thread_id = record["thread_id"]
    if not voice.enabled() or not _phone_number(record.get("to")):
        await run_on_thread(lg, thread_id, tagged(CHANNEL_TAG, f"No reply after {call_after_s():.0f} s."), "channel")
        return

    started = _iso(_now())
    def claim(rec):
        if rec.get("reply") or rec.get("call") or _quiet_age(rec) < call_after_s():
            return rec
        return _call_change(rec, status="ringing", started_at=started, conversation_id=None)
    current = await update_record(lg, thread_id, claim)
    if not current or (current.get("call") or {}).get("started_at") != started:
        return
    call_id = None
    try:
        await run_on_thread(lg, thread_id, tagged(CHANNEL_TAG, f"No reply after {call_after_s():.0f} s. Calling the on-call clinician."), "channel")
        state = await lg.threads.get_state(thread_id)
        variables = {"report": str(current.get("report") or ""), "message": str(current.get("message") or ""),
                     "patient_id": str(current.get("patient_id") or ""), "evidence": _evidence(state.get("values") or {})}
        # A decision may have arrived while the thread was busy with the channel event.
        fresh = await update_record(lg, thread_id, lambda rec: rec)
        if not fresh or fresh.get("reply"):
            if fresh:
                await update_record(lg, thread_id, lambda rec: _call_change(rec, status="cancelled"))
            return
        if _quiet_age(fresh) < call_after_s():
            # A question arrived before dialing: restart the silence clock instead.
            await update_record(lg, thread_id, lambda rec: {**rec, "call": None, "no_reply_at": None} if not rec.get("reply") else _call_change(rec, status="cancelled"))
            return
        call_id = await asyncio.to_thread(voice.place_call, current["to"], variables)
        await update_record(lg, thread_id, lambda rec: _call_change(rec, conversation_id=call_id))
        outcome = await asyncio.to_thread(voice.wait_for_call, call_id)
    except Exception as exc:
        log.warning("call for %s failed (%s)", thread_id, type(exc).__name__)
        outcome = None

    if outcome and outcome.get("answered"):
        await update_record(lg, thread_id, lambda rec: _call_change(rec, status="answered", summary=outcome.get("summary") or "", duration_s=outcome.get("duration_s")))
        content = tagged(CALL_TAG, f"decision: {outcome.get('decision', 'none')}. Summary: {outcome.get('summary') or ''} Transcript: {json.dumps(outcome.get('transcript') or [])}")
        recap = await run_on_thread(lg, thread_id, content, "call")
        if recap:
            await send_to_clinician(current, recap, f"call-recap:{call_id}")
    else:
        status = "no_answer" if outcome is not None else "failed"
        fresh = await update_record(lg, thread_id, lambda rec: _call_change(rec, status=status, summary="", duration_s=(outcome or {}).get("duration_s")))
        await run_on_thread(lg, thread_id, tagged(CHANNEL_TAG, "The call was not answered."), "channel")
        # Avoid asking for a decision again when a text decision already arrived.
        fresh = await update_record(lg, thread_id, lambda rec: rec) or fresh
        if fresh and not fresh.get("reply"):
            when = _at(started).astimezone().strftime("%-I:%M %p %Z")
            await send_to_clinician(fresh, f"I tried to call at {when} about a pre-alert. Reply ACCEPT or DECLINE.", f"call-no-answer:{call_id or thread_id}")


# ---- The loop --------------------------------------------------------------


class Bridge:
    def __init__(self, lg) -> None:
        self.lg = lg
        self.cursor: dict = {}
        self.inflight: dict[str, str] = {}  # message id -> createdAt, handled by a task right now
        self.tasks: set[asyncio.Task] = set()
        self.last: dict[str, asyncio.Task] = {}  # space id -> the task handling its newest text

    async def load_cursor(self) -> None:
        item = await self.lg.store.get_item(list(BRIDGE_NS), key="cursor")
        if item:
            self.cursor = item["value"]
            return
        # First start ever: begin now. Older texts (setup, earlier tests) are never answered, including the overlap window.
        now = _now()
        old = await photon.list_received(_iso(now - timedelta(seconds=OVERLAP_S)))
        self.cursor = {"since": _iso(now), "handled": {m["id"]: m["createdAt"] for m in old}}
        await self.save_cursor()

    async def save_cursor(self) -> None:
        """`since` never passes a message still being handled, so a restart re-reads it rather than skipping it."""
        handled = self.cursor["handled"]
        since = min([*self.inflight.values(), max([self.cursor["since"], *handled.values()])])
        keep = _iso(_at(since) - timedelta(seconds=HANDLED_KEEP_S))
        self.cursor = {"since": since, "handled": {k: v for k, v in handled.items() if v >= keep}}
        await self.lg.store.put_item(list(BRIDGE_NS), key="cursor", value=self.cursor)

    def spawn(self, coro, name: str) -> asyncio.Task:
        task = asyncio.create_task(coro, name=name)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    async def run(self) -> None:
        await self.load_cursor()
        log.info("bridge up: LangGraph %s, reading texts since %s", photon.langgraph_url(), self.cursor["since"])
        while True:
            started = monotonic()
            try:
                await self.tick()
            except Exception:
                log.exception("tick failed; carrying on")
            await asyncio.sleep(max(0.0, POLL_S - (monotonic() - started)))

    async def tick(self) -> None:
        since = _iso(_at(self.cursor["since"]) - timedelta(seconds=OVERLAP_S))
        for m in await photon.list_received(since):
            if m["id"] not in self.cursor["handled"] and m["id"] not in self.inflight:
                self.inflight[m["id"]] = m["createdAt"]
                space = (m.get("space") or {}).get("id", "")
                self.last[space] = self.spawn(self.handle(m, after=self.last.get(space)), f"text {m['id']}")
        await self.follow_handoffs()

    async def handle(self, m: dict, after: asyncio.Task | None = None) -> None:
        """One text, after the sender's previous one: "ok" then "ACCEPT" reach the lead in that order."""
        try:
            if after and not after.done():
                await asyncio.wait([after])
            await self.on_text(m)
        except Exception:
            log.exception("text %s not handled", m["id"])
        finally:
            self.cursor["handled"][m["id"]] = self.inflight.pop(m["id"])
            await self.save_cursor()

    async def on_text(self, m: dict) -> None:
        if (m.get("sentBy") or {}).get("kind") != "human" or (m.get("space") or {}).get("kind") != "direct":
            return
        handle, space, agent = m["sentBy"]["handle"], m["space"]["id"], m["receivedBy"]["id"]
        text = photon.message_text(m)
        if text is None:  # a reaction or an attachment: nothing to answer
            return
        cmd = photon.roster_command(text)
        if cmd:
            entry = photon.oncall_entry(m, cmd == "on")
            await self.lg.store.put_item(list(photon.ONCALL_NS), key=handle, value=entry)
            await photon.send_text(space, agent, ON_CALL_REPLY if cmd == "on" else OFF_REPLY, f"roster:{m['id']}")
            log.info("%s is %s", photon.mask(handle), "on call" if cmd == "on" else "off call")
            return
        record = await self.open_handoff(handle, space)
        if record is None:  # never case content for someone without an open hand-off
            await photon.send_text(space, agent, NO_HANDOFF_REPLY, f"reply:{m['id']}")
            log.info("text from %s with no open hand-off", photon.mask(handle))
            return
        # The latest clinician text restarts the silence clock, including out-of-order arrivals.
        await update_record(self.lg, record["thread_id"], lambda rec: {**rec, "clinician_at": max(rec.get("clinician_at") or m["createdAt"], m["createdAt"])})
        thread = await self.lg.threads.get(record["thread_id"])
        if thread["status"] == "interrupted":
            await send_to_clinician(record, PAUSED_REPLY, f"held:{m['id']}")
            log.info("thread %s paused for the medic; holding text %s", record["thread_id"], m["id"])
        else:
            await self.typing(record)
        t0 = monotonic()
        answer = await run_on_thread(self.lg, record["thread_id"], tagged(CLINICIAN_TAG, text), "clinician")
        if answer:
            await send_to_clinician(record, answer, f"reply:{m['id']}")
        log.info("answered %s in %.1f s after the text arrived (run %.1f s)", m["id"], _age_s(m["createdAt"]), monotonic() - t0)

    async def typing(self, record: dict) -> None:
        try:
            await photon.set_typing(record["space_id"], record["agent_user_id"], True)
        except Exception as e:  # cosmetic; shared lines may not support it
            log.debug("typing not shown: %s", e)

    async def open_handoff(self, handle: str, space_id: str) -> dict | None:
        """The newest hand-off that went to this sender in this space, sent within OPEN_FOR_S."""
        mine = [
            r
            for r in await handoffs(self.lg)
            if r.get("space_id") == space_id and r.get("to") == handle and not r.get("simulated") and r.get("status") != "no_one_on_call" and _age_s(r.get("sent_at")) < OPEN_FOR_S
        ]
        return max(mine, key=lambda r: r["sent_at"]) if mine else None

    async def follow_handoffs(self) -> None:
        """Delivery status for recent pre-alerts, a failed delivery told to the medic, and the silence hook."""
        for r in await handoffs(self.lg):
            if r.get("simulated") or r.get("status") == "no_one_on_call" or _age_s(r.get("sent_at")) > TRACK_FOR_S:
                continue
            thread_id = r["thread_id"]
            waiting = [m["id"] for m in r.get("messages") or [] if m["status"] == "queued"]
            if waiting:
                statuses, delivered = {}, {}
                for mid in waiting:
                    try:
                        m = await photon.get_message(mid)
                        statuses[mid], delivered[mid] = m["status"], (m.get("timestamps") or {}).get("deliveredAt")
                    except Exception as e:
                        log.warning("status of %s unknown: %s", mid, e)
                was = r["status"]
                r = await update_record(self.lg, thread_id, lambda rec: delivery_update(rec, statuses, delivered)) or r
                if r["status"] != was:
                    log.info("hand-off %s: %s -> %s", thread_id, was, r["status"])
                    if r["status"] == "failed":  # the medic's to hear, not the clinician's
                        content = tagged(CHANNEL_TAG, "The pre-alert could not be delivered.")
                        self.spawn(run_on_thread(self.lg, thread_id, content, "channel"), f"failed {thread_id}")
            if silent(r):
                mark = _iso(_now())
                r = await update_record(self.lg, thread_id, lambda rec: {**rec, "no_reply_at": mark} if silent(rec) else rec)
                if r and r.get("no_reply_at") == mark:
                    log.info("hand-off %s: no reply after %.0f s", thread_id, call_after_s())
                    self.spawn(on_no_reply(r, self.lg), f"no reply {thread_id}")


def _quiet_age(r: dict) -> float:
    return min(_age_s(r.get("sent_at")), _age_s(r.get("clinician_at")))


def silent(r: dict) -> bool:
    """Fire once after the last pre-alert or clinician text, unless a decision or call exists."""
    quiet = not (r.get("reply") or r.get("call") or r.get("no_reply_at"))
    return quiet and r.get("status") in ("sent", "delivered", "read") and _quiet_age(r) >= call_after_s()


async def main() -> None:
    photon._load_env()
    logging.basicConfig(level=os.getenv("LUCID_BRIDGE_LOG", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # request lines carry project ids, not keys, but are noise
    if not photon.enabled():
        raise SystemExit("PHOTON_PROJECT_ID and PHOTON_API_KEY are not set (../.env).")
    await Bridge(photon.client()).run()


if __name__ == "__main__":
    asyncio.run(main())
