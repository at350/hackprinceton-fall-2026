"""Agent state. The dashboard reads these fields directly (see lib/types.ts)."""

from typing import Annotated, Any, NotRequired

from deepagents import DeepAgentState

_STATUS_RANK = {"queued": 0, "running": 1, "done": 2}


def merge_sims(current: list[dict] | None, update: list[dict] | dict | None) -> list[dict]:
    """Merge simulation patches by id.

    `{"reset": [...]}` replaces the list (a new scan). A plain list patches by id
    and never moves a simulation backwards: the four region agents each hand back
    their own copy of the list, and a stale "queued" must not undo a "done".
    """
    if update is None:
        return current or []
    if isinstance(update, dict):
        return list(update.get("reset", []))
    by_id = {s["id"]: s for s in current or []}
    for patch in update:
        old = by_id.get(patch["id"])
        if old is None:
            by_id[patch["id"]] = patch
        elif _STATUS_RANK[patch.get("status", old["status"])] >= _STATUS_RANK[old["status"]]:
            by_id[patch["id"]] = {**old, **patch}
    return list(by_id.values())


def last(_: Any, new: Any) -> Any:
    return new


class LucidState(DeepAgentState):
    # Input: which mock scan is on the device, and whose head it is.
    scan_id: NotRequired[Annotated[str, last]]
    patient_id: NotRequired[Annotated[str, last]]

    # UI: ScanUpdate. `status` stays "pending" until the medic approves a result.
    scan: NotRequired[Annotated[dict | None, last]]
    # UI: ScanSpot[]
    spots: NotRequired[Annotated[list[dict], last]]
    # UI: Simulation[]
    sims: NotRequired[Annotated[list[dict], merge_sims]]
    # UI: the map of the result the medic is being asked to approve.
    preview: NotRequired[Annotated[dict | None, last]]
    # UI: set once the medic approved a pre-alert. Without a Photon key: {to, message, report, sent_at, simulated: True}.
    # With one: {to (masked handle), message (as sent), report, sent_at, simulated: False, channel: "imessage",
    # status: "sent" | "failed" | "no_one_on_call", reply: None}. Live delivery and replies are in the Store
    # record ["lucid", "handoffs"] / <thread id>. After a re-scan update it is the update: kind "update", reply = the
    # acceptance it followed.
    handoff: NotRequired[Annotated[dict | None, last]]
    # On a later scan: the clinician who accepted this patient's hand-off, from any thread, so the result card can say
    # they will be told (it is built without I/O). {thread_id, to, space_id, agent_user_id, reply}, or None.
    accepted_by: NotRequired[Annotated[dict | None, last]]
    # The on-call clinician the pre-alert card names, looked up from the roster when a bleed result is approved
    # (the card is built without I/O). {handle, space_id, agent_user_id, since, active}, or None if nobody is on call.
    recipient: NotRequired[Annotated[dict | None, last]]

    # Working data for the tools (raw spot readings, earlier scan, no-bleed fit).
    reading: NotRequired[Annotated[dict | None, last]]
    baseline: NotRequired[Annotated[dict | None, last]]
    null_fit: NotRequired[Annotated[float | None, last]]
    # How many times the medic has re-scanned weak spots for this scan (at most once).
    rescans: NotRequired[Annotated[int, last]]
