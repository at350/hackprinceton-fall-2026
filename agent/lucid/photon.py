"""Photon 2.0 beta (iMessage) over plain HTTP, and the on-call roster.

The pre-alert tool sends through here; the replies bridge (a separate long-running
process) reads and writes through here too, so nothing in this module holds a
connection or a loop between calls. Every send carries an idempotency key derived
from what caused it, so a retry or a re-run never texts twice.

    python -m lucid.photon sync               # roster from received texts ("on call" / "off")
    python -m lucid.photon oncall +15551234567  # put a handle on call by hand
    python -m lucid.photon off +15551234567
    python -m lucid.photon roster
"""

import asyncio
import hashlib
import json
import os
import re
import sys
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path

import httpx

BASE_URL = os.getenv("PHOTON_BASE_URL", "https://api.photon.codes")
ONCALL_NS = ("lucid", "oncall")
HANDOFFS_NS = ("lucid", "handoffs")

SAFETY_LINE = "Screening aid, not a diagnosis. Confirm with CT."
REPLY_LINE = "Reply ACCEPT or DECLINE, or ask me about the scan."
# The model ends a pre-alert the way the safety skill says; the canonical line replaces it.
_TRAILING_SAFETY = re.compile(r"\s*screening aid,? not a diagnosis\.?\s*(?:(?:please prepare|confirm with) (?:a )?ct\.?)?\s*$", re.I)
_LEADING_PREALERT = re.compile(r"^\s*(?:lucid )?pre-?alert\b[\s,:.\-]*", re.I)  # the header says it

_RETRY_STATUS = {429, 502, 503, 504}
_MAX_WAIT_S = 10.0


class PhotonError(Exception):
    """A Photon problem response. `code` is Photon's (e.g. SHARED_LINE_INBOUND_REQUIRED)."""

    def __init__(self, status: int, code: str, detail: str = "") -> None:
        super().__init__(f"Photon {status} {code}" + (f": {detail}" if detail else ""))
        self.status, self.code, self.detail = status, code, detail


def enabled() -> bool:
    """True when the keys are set. A server started before they were added to ../.env reads them here; variables
    already set win, and a hot reload does not re-read the env file, so this does."""
    if not (os.getenv("PHOTON_PROJECT_ID") and os.getenv("PHOTON_API_KEY")):
        _load_env()
    return bool(os.getenv("PHOTON_PROJECT_ID") and os.getenv("PHOTON_API_KEY"))


def mask(handle: str | None) -> str:
    """A handle as the medic sees it: only the last four digits of a phone number."""
    if not handle:
        return "nobody"
    if handle.startswith("+"):
        return f"{'+1 ' if handle.startswith('+1') and len(handle) == 12 else ''}... {handle[-4:]}"
    name, _, domain = handle.partition("@")
    return f"{name[:1]}...@{domain}" if domain else f"... {handle[-4:]}"


# ---- Request bodies (pure, so tests can check exactly what goes out) -------


def text_body(space_id: str, sender_id: str, text: str) -> dict:
    return {"spaceId": space_id, "senderId": sender_id, "content": {"type": "text", "format": "plain", "text": text}}


def attachment_body(space_id: str, sender_id: str, attachment_id: str) -> dict:
    return {"spaceId": space_id, "senderId": sender_id, "content": {"type": "attachment", "attachmentId": attachment_id}}


def multipart(data: bytes, filename: str, content_type: str = "image/png") -> tuple[bytes, str]:
    """The upload body: exactly two parts, the JSON description then the bytes. Returns (body, content-type header).

    The boundary comes from the bytes, so a retry with the same idempotency key sends the same request.
    """
    boundary = "lucid" + hashlib.sha256(data).hexdigest()[:32]
    meta = json.dumps({"contentType": content_type, "sizeBytes": len(data), "filename": filename}).encode()
    body = (
        f"--{boundary}\r\nContent-Type: application/json\r\n\r\n".encode()
        + meta
        + f"\r\n--{boundary}\r\nContent-Type: {content_type}\r\n\r\n".encode()
        + data
        + f"\r\n--{boundary}--\r\n".encode()
    )
    return body, f"multipart/related; boundary={boundary}"  # Photon refuses any other parameter (e.g. type=)


def prealert_text(message: str, patient_id: str) -> str:
    """The pre-alert as sent: who it is from and for which patient (id, never a name), the model's text, the safety line, how to reply."""
    body = _LEADING_PREALERT.sub("", _TRAILING_SAFETY.sub("", message.strip())).strip()
    body = body[:1].upper() + body[1:]
    head = "Lucid pre-alert" + ("" if patient_id in body else f", patient {patient_id}")
    return f"{head}\n{body}\n{SAFETY_LINE}\n\n{REPLY_LINE}"


# ---- HTTP -----------------------------------------------------------------


def _retry_after(r: httpx.Response, attempt: int) -> float:
    raw = r.headers.get("retry-after")
    try:
        wait = float(raw)
    except (TypeError, ValueError):
        try:
            wait = (parsedate_to_datetime(raw) - datetime.now(UTC)).total_seconds()
        except (TypeError, ValueError):
            wait = 0.5 * 2**attempt
    return min(_MAX_WAIT_S, max(0.0, wait))


def _error(r: httpx.Response) -> PhotonError:
    try:
        p = r.json()
    except ValueError:
        p = {}
    return PhotonError(r.status_code, p.get("code") or f"HTTP_{r.status_code}", p.get("detail") or p.get("title") or "")


async def _call(method: str, path: str, *, retries: int = 3, **kw) -> dict:
    """One Photon call, waiting out 429 (Retry-After) and brief gateway errors. Sends are safe to retry: they carry idempotency keys."""
    url = f"{BASE_URL}/v1/projects/{os.environ['PHOTON_PROJECT_ID']}{path}"
    headers = {"authorization": f"Bearer {os.environ['PHOTON_API_KEY']}", **kw.pop("headers", {})}
    async with httpx.AsyncClient(timeout=20) as client:
        for attempt in range(retries + 1):
            r = await client.request(method, url, headers=headers, **kw)
            if r.status_code in _RETRY_STATUS and attempt < retries:
                await asyncio.sleep(_retry_after(r, attempt))
                continue
            if r.status_code >= 400:
                raise _error(r)
            return r.json() if r.content else {}
    raise AssertionError("unreachable")


async def _send(body: dict, key: str) -> dict:
    """POST a message. 202 means queued for delivery, not delivered."""
    return await _call("POST", "/messages", json=body, headers={"idempotency-key": key})


async def send_text(space_id: str, sender_id: str, text: str, key: str) -> str:
    # LUCID_PHOTON_PREFIX="[Lucid test] " marks every text from a test server.
    text = os.getenv("LUCID_PHOTON_PREFIX", "") + text
    return (await _send(text_body(space_id, sender_id, text), key))["id"]


async def send_image(space_id: str, sender_id: str, png: bytes, filename: str, key: str) -> str:
    """Upload the image, then send it as an attachment message. Returns the message id."""
    body, ctype = multipart(png, filename)
    headers = {"content-type": ctype, "content-length": str(len(body)), "idempotency-key": f"{key}:upload"}
    for attempt in range(6):
        try:
            att = await _call("POST", "/attachments", content=body, headers=headers)
            break
        except PhotonError as e:  # the same upload is still being committed
            if e.code != "ATTACHMENT_UPLOAD_NOT_READY" or attempt == 5:
                raise
            await asyncio.sleep(0.5)
    for attempt in range(6):
        try:
            return (await _send(attachment_body(space_id, sender_id, att["id"]), key))["id"]
        except PhotonError as e:
            if e.code != "ATTACHMENT_NOT_READY" or attempt == 5:
                raise
            await asyncio.sleep(0.5)
    raise AssertionError("unreachable")


async def list_received(created_since: str) -> list[dict]:
    """Received iMessages since a time (RFC 3339), oldest first, all pages."""
    params = {"direction": "received", "platform": "imessage", "order": "asc", "createdSince": created_since, "pageSize": 200}
    out: list[dict] = []
    while True:
        page = await _call("GET", "/messages", params=params)
        out += page.get("items", [])
        if not page.get("nextPageToken"):
            return out
        params["pageToken"] = page["nextPageToken"]


async def get_message(message_id: str) -> dict:
    """One message; `status` is dispatched, accepted, delivered or failed for a sent one."""
    return await _call("GET", f"/messages/{message_id}")


async def set_typing(space_id: str, sender_id: str, on: bool) -> bool:
    """Show or clear the typing bubble. False where the line does not support it (shared lines may not)."""
    try:
        await _call("POST", f"/spaces/{space_id}/typing", json={"senderId": sender_id, "typing": on})
        return True
    except PhotonError as e:
        if e.code == "OPERATION_UNAVAILABLE":
            return False
        raise


# ---- The on-call roster ---------------------------------------------------


def message_text(m: dict) -> str | None:
    c = m.get("content") or {}
    return c.get("text") if c.get("type") == "text" else None


def roster_command(text: str | None) -> str | None:
    """"on" for "On call" (any case, spacing or hyphen, a trailing full stop), "off" for "off" / "off call", else None."""
    t = re.sub(r"[\s\-]+", " ", (text or "").strip().lower()).rstrip(".!")
    return {"on call": "on", "oncall": "on", "off": "off", "off call": "off"}.get(t)


def oncall_entry(m: dict, active: bool, since: str | None = None) -> dict:
    """A roster entry from a received message: who sent it, the space to reply in, and the agent line it reached."""
    return {"handle": m["sentBy"]["handle"], "space_id": m["space"]["id"], "agent_user_id": m["receivedBy"]["id"], "since": since or m["createdAt"], "active": active}


def roster_changes(messages: list[dict]) -> list[dict]:
    """Each sender's latest "on call" or "off", as roster entries. Other texts leave the roster as it is."""
    latest: dict[str, dict] = {}
    for m in sorted(messages, key=lambda m: m["createdAt"]):
        cmd = roster_command(message_text(m))
        if cmd and (m.get("sentBy") or {}).get("kind") == "human":
            latest[m["sentBy"]["handle"]] = oncall_entry(m, cmd == "on")
    return list(latest.values())


def pick_oncall(entries: list[dict]) -> dict | None:
    """Who gets the pre-alert: the active entry that came on call most recently."""
    active = [e for e in entries if e.get("active")]
    return max(active, key=lambda e: e["since"]) if active else None


def langgraph_url() -> str:
    return os.getenv("LANGGRAPH_URL", "http://localhost:2024")


def client(url: str | None = None):
    from langgraph_sdk import get_client

    return get_client(url=url or langgraph_url())


async def roster(lg) -> list[dict]:
    return [i["value"] for i in (await lg.store.search_items(list(ONCALL_NS), limit=100))["items"]]


async def apply_roster(lg, messages: list[dict]) -> list[dict]:
    """Write the roster changes in these messages to the Store. A change older than the entry on file
    (say an "On call" from before someone was put on call by hand) is skipped. Returns what was written."""
    have = {e["handle"]: e for e in await roster(lg)}
    written = []
    for e in roster_changes(messages):
        if e["handle"] in have and have[e["handle"]]["since"] >= e["since"]:
            continue
        await lg.store.put_item(list(ONCALL_NS), key=e["handle"], value=e)
        written.append(e)
    return written


def _days_ago(days: float) -> str:
    return (datetime.now(UTC) - timedelta(days=days)).isoformat(timespec="seconds").replace("+00:00", "Z")


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


async def sync(lg=None, created_since: str | None = None) -> list[dict]:
    """One pass: read received texts (default: the last 7 days) and update the roster."""
    return await apply_roster(lg or client(), await list_received(created_since or _days_ago(7)))


async def set_oncall(handle: str, active: bool, lg=None) -> dict:
    """Put a handle on (or off) call by hand. The space and agent ids come from their latest text,
    so they must have texted the Photon number since it was assigned to them."""
    mine = [m for m in await list_received(_days_ago(30)) if (m.get("sentBy") or {}).get("handle") == handle]
    if not mine:
        raise SystemExit(f"No text from {mask(handle)} in the last 30 days. They must text the Photon number first.")
    entry = oncall_entry(mine[-1], active, since=_now())
    await (lg or client()).store.put_item(list(ONCALL_NS), key=handle, value=entry)
    return entry


def _load_env() -> None:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parents[2] / ".env")


async def _main(argv: list[str]) -> None:
    _load_env()
    if not enabled():
        raise SystemExit("PHOTON_PROJECT_ID and PHOTON_API_KEY are not set (../.env).")
    cmd, *rest = argv or ["sync"]

    def show(e: dict) -> str:
        return f"{mask(e['handle'])}  {'ON CALL' if e['active'] else 'off'}  since {e['since']}  space {e['space_id']}"

    if cmd == "sync":
        written = await sync()
        print(f"{len(written)} roster change(s)." + "".join(f"\n  {show(e)}" for e in written))
    elif cmd in ("oncall", "off") and len(rest) == 1:
        print(show(await set_oncall(rest[0], cmd == "oncall")))
    elif cmd == "roster":
        entries = await roster(client())
        print("\n".join(map(show, entries)) or "Roster is empty.")
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    asyncio.run(_main(sys.argv[1:]))
