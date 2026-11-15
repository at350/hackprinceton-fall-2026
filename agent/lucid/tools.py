"""Lucid's tools. Each does one narrow thing and keeps the dashboard state current.

Tools return a short text for the model and write the full data to state, so the
model never has to carry maps or tables through its context.
"""

import asyncio
import json
import re
from datetime import UTC, datetime

import httpx
from langchain.tools import ToolRuntime, tool
from langchain_core.messages import ToolMessage
from langgraph.types import Command

from lucid import atlas, photon, physics
from lucid.backend import backend, baseline_path, notes_path
from lucid.config import COARSE_VOLUMES, DEFAULT_PATIENT, DEFAULT_SCAN, ETA_MIN, MAX_HYPOTHESES, MAX_NEW_PER_CALL, MEDIC_NOTES, ORIGIN, SIM_PACE_S, UNIT
from lucid.decision import decide, describe
from lucid.device import SCAN_ID as DEVICE_SCAN
from lucid.device import client as device

NO_BLEED = "no-bleed"
SCAN_FILE = "/scan.json"
PLAN_FILE = "/hypotheses.json"
REVIEW_FILE = "/review.md"
REPORT_FILE = "/report.md"
_BY_ID = {h["id"]: h for h in physics.all_hypotheses()}
physics.lookup(next(iter(_BY_ID)))  # load the lookup table at import, not inside the event loop
_archiving: set[asyncio.Task] = set()  # the loop keeps only weak references to tasks


def _ids(raw: list[str]) -> list[str]:
    """De-duplicated ids with the volume zero-padded: models write epi-LT-5 as readily as epi-LT-05."""
    out = []
    for i in raw:
        head, _, vol = str(i).strip().rpartition("-")
        out.append(f"{head}-{int(vol):02d}" if head and vol.isdigit() else str(i).strip())
    return list(dict.fromkeys(out))


def sims_file(lobe: str) -> str:
    return f"/sims/{lobe}.json"


def _reply(runtime: ToolRuntime, text: str, **update) -> Command:
    return Command(update={**update, "messages": [ToolMessage(text, tool_call_id=runtime.tool_call_id)]})


def _emit(runtime: ToolRuntime, event: dict) -> None:
    """Send a live event to the dashboard (stream mode "custom")."""
    runtime.stream_writer(event)


def _caller(runtime: ToolRuntime) -> str:
    """Which agent is calling: "lucid" (the lead), a region name, or "skeptic"."""
    return (runtime.config.get("metadata") or {}).get("lc_agent_name") or "lucid"


async def _read_text(path: str) -> str | None:
    res = await backend.aread(path)
    return None if res.error or not res.file_data else res.file_data["content"]


async def _read_json(path: str) -> dict | None:
    try:
        return json.loads(await _read_text(path) or "")
    except (json.JSONDecodeError, TypeError):
        return None


def _patient(runtime: ToolRuntime) -> str:
    return runtime.state.get("patient_id") or DEFAULT_PATIENT


# ---- Scan -----------------------------------------------------------------


def _scan_rows(scan: dict, only: list[int] | None = None) -> list[str]:
    healthy = physics.null_reading()
    return [
        f"{s['index']} {s['name']:<11} coil {s['coil_db']:.2f} dB ({s['coil_db'] - healthy['coil_db'][s['index']]:+.2f})  "
        f"NIR {s['nir']:.3f} ({s['nir'] - healthy['nir'][s['index']]:+.3f})  contact {s['quality']}"
        for s in scan["spots"]
        if only is None or s["index"] in only
    ]


async def _publish_scan(runtime: ToolRuntime, scan: dict) -> dict:
    """Put a scan on the dashboard and in the file system. Returns the state update."""
    healthy = physics.null_reading()
    peaks = physics.spot_peaks(scan)
    spots = [
        {"index": s["index"], "name": s["name"], "angle": s["angle"], "state": "done" if s["quality"] == "good" else "rescan", "peak": peaks[s["index"]]}
        for s in scan["spots"]
    ]
    view = {
        "spot": 7,
        "done": True,
        "map": await asyncio.to_thread(physics.likelihood_map, scan, 64),
        "status": "pending",  # no result is stated before the medic approves it
        "transport": scan.get("transport"),
        "medic_notes": scan.get("medic_notes"),
        "region": "None",
        "volume_ml": 0,
        "confidence": 0,
    }
    _emit(runtime, {"type": "scan", "scan": view, "spots": spots, "reading": scan})
    # The region agents and the skeptic read the scan from this file.
    doc = {
        "patient_id": scan["patient_id"],
        "taken_at": scan["taken_at"],
        "transport": scan.get("transport"),
        "medic_notes": scan.get("medic_notes"),
        "healthy": {"coil_db": healthy["coil_db"][0], "nir": healthy["nir"][0]},
        "spots": [
            {**s, "coil_change_db": round(s["coil_db"] - healthy["coil_db"][s["index"]], 2), "nir_change": round(s["nir"] - healthy["nir"][s["index"]], 4)}
            for s in scan["spots"]
        ],
    }
    body = ",\n".join(f"  {json.dumps(s)}" for s in doc.pop("spots"))
    await backend.awrite(SCAN_FILE, json.dumps(doc)[:-1] + ', "spots": [\n' + body + "\n]}")
    return {"reading": scan, "scan": view, "spots": spots}


@tool
async def read_scan(runtime: ToolRuntime) -> Command:
    """Read the current scan from the device: 8 spots around the head, each with a coil signal (dB) and a NIR value.

    Call this first. Returns a table of the readings and how each differs from a healthy head,
    and saves the same table to /scan.json for the other agents.
    """
    case = runtime.state.get("scan_id") or DEFAULT_SCAN
    if case != DEVICE_SCAN and case not in physics.MOCK_CASES:
        return _reply(runtime, f"Unknown scan '{case}'. Available: {', '.join((*physics.MOCK_CASES, DEVICE_SCAN))}.")
    has_baseline = await _read_json(baseline_path(_patient(runtime))) is not None
    if case == DEVICE_SCAN:
        # Device mode: the 8 spots the medic just read on the probe, from the device bridge (lucid/device).
        try:
            scan = {"case": DEVICE_SCAN, "taken_at": None, "spots": await asyncio.to_thread(device.read_scan)}
        except device.DeviceError as e:
            return _reply(runtime, f"Can't read the device: {e}")
    else:
        # Simulated device: the mock returns the 15-minutes-later scan once a baseline exists.
        scan = physics.mock_scan(case, rescan=has_baseline)
    taken = datetime.now(UTC).isoformat(timespec="seconds")
    # Simulated like the device: which unit has the patient and how far out it is (lucid/config.py).
    transport = {"unit": UNIT, "eta_min": ETA_MIN, "origin": ORIGIN, "as_of": taken}
    notes = {**MEDIC_NOTES, "text": photon.notes_line(MEDIC_NOTES), "as_of": taken}  # the medic's notes, simulated the same way
    scan |= {"taken_at": taken, "patient_id": _patient(runtime), "later_scan": has_baseline, "transport": transport, "medic_notes": notes}
    for stale in (*map(sims_file, physics.LOBES), REVIEW_FILE, REPORT_FILE):  # from an earlier scan on this thread
        await backend.adelete(stale)
    update = await _publish_scan(runtime, scan)
    text = (
        f"Scan for patient {scan['patient_id']} taken {scan['taken_at']}. Change from a healthy head in brackets.\n"
        + "\n".join(_scan_rows(scan))
        + ("\nAn earlier scan of this patient is on file." if has_baseline else "\nNo earlier scan of this patient is on file.")
        + f"\nTransport: {UNIT}, ETA about {ETA_MIN} min, {ORIGIN}. It goes in the pre-alert and /report.md."
        + f"\nMedic's notes: {notes['text']} One line in /report.md, not in the pre-alert; answer the clinician's questions from them."
    )
    accepted = await _accepted_handoff(runtime) if has_baseline else None
    return _reply(runtime, text, **update, null_fit=None, handoff=None, recipient=None, accepted_by=accepted, preview=None, rescans=0)


@tool
async def recall_baseline(runtime: ToolRuntime) -> Command:
    """Load this patient's baseline (their first approved scan) from long-term memory, to compare a re-scan against it."""
    base = await _read_json(baseline_path(_patient(runtime)))
    if base is None:
        return _reply(runtime, "No baseline on file. This scan becomes the baseline once the medic approves its result.", baseline=None)
    then = datetime.fromisoformat(base["taken_at"])
    minutes = max(1, round((datetime.now(UTC) - then).total_seconds() / 60))
    r = base["result"]
    text = (
        f"Baseline scan from {minutes} min ago. Approved result then: {r['status']}"
        + (f", {r['type']}, {r['region']}, about {r['volume_ml']} mL (fit {r['confidence']:.2f})." if r["status"] == "bleed" else ".")
        + "\nCompare the new best-fit region and volume with this and report growth or no change."
    )
    return _reply(runtime, text, baseline=base)


def weak_spots(reading: dict | None) -> list[int]:
    return [s["index"] for s in (reading or {}).get("spots", []) if s["quality"] == "weak"]


def rescan_needs_approval(request) -> bool:
    """Only a first re-scan of spots that really had weak contact goes to the medic."""
    spots = request.tool_call["args"].get("spots") or []
    weak = weak_spots(request.state.get("reading"))
    return bool(spots) and set(spots) <= set(weak) and not request.state.get("rescans")


def describe_rescan(tool_call, state, _runtime) -> str:
    names = [physics.SPOT_NAMES[i] for i in tool_call["args"].get("spots", []) if 0 <= i < 8]
    return f"Re-scan {' and '.join(names)}?\nContact was weak there. Part the hair, press the device flat, and scan {'those spots' if len(names) > 1 else 'that spot'} again."


@tool
async def request_rescan(spots: list[int], reason: str, runtime: ToolRuntime) -> Command:
    """Ask the medic to scan specific weak-contact spots again, then read the new values. Pauses until the medic has done it.

    Use once, when the result would be "uncertain" and the scan has weak-contact spots.

    Args:
        spots: Spot numbers to scan again (0-7), e.g. [5, 6]. Only spots whose contact was weak.
        reason: One sentence for the medic on why.
    """
    state = runtime.state
    old = state.get("reading")
    weak = weak_spots(old)
    if not old or not spots or not set(spots) <= set(weak) or state.get("rescans"):
        return _reply(runtime, f"Not possible: a re-scan is offered once per scan, and only for weak-contact spots (currently {weak or 'none'}).")
    if old["case"] == DEVICE_SCAN:
        # The bridge reads those spots again as the medic re-seats the probe, and this waits for it.
        try:
            scan = {"case": DEVICE_SCAN, "taken_at": None, "spots": await asyncio.to_thread(device.rescan, list(spots))}
        except device.DeviceError as e:
            return _reply(runtime, f"The re-scan did not complete: {e} The first readings stand.")
    else:
        scan = physics.mock_scan(old["case"], rescan=old.get("later_scan", False), reseat=tuple(spots))
    scan |= {"taken_at": datetime.now(UTC).isoformat(timespec="seconds"), "patient_id": old["patient_id"], "later_scan": old.get("later_scan", False), "transport": old.get("transport"),
             "medic_notes": old.get("medic_notes")}
    for stale in (*map(sims_file, physics.LOBES), REVIEW_FILE):  # results for the old readings no longer count
        await backend.adelete(stale)
    update = await _publish_scan(runtime, scan)
    sims = await asyncio.to_thread(_queued, _plan())
    _emit(runtime, {"type": "sims_reset", "sims": sims})
    text = (
        "Medic re-scanned. New readings for those spots (also in /scan.json):\n"
        + "\n".join(_scan_rows(scan, spots))
        + "\nAll earlier fit scores are void. Run the four region agents and fit_score(['no-bleed']) again, then rank_fits and the skeptic."
    )
    return _reply(runtime, text, **update, sims={"reset": sims}, null_fit=None, preview=None, rescans=1)


# ---- Hypotheses and simulation --------------------------------------------


def _plan() -> list[dict]:
    """The coarse sweep: every type in every region at a few volumes. The region agents refine from here."""
    return [_BY_ID[physics.hypothesis_id(t, region, v)] for region in physics.REGION_ANGLE for t in physics.BLEED_TYPES for v in COARSE_VOLUMES]


def _queued(hyps: list[dict], **extra) -> list[dict]:
    return [
        {**h, "status": "queued", "score": 0, "progress": 0, "pass": "coarse", **extra, "map": physics.hypothesis_map(h["type"], h["region"], h["volume_ml"], 32)}
        for h in hyps
    ]


@tool
async def plan_hypotheses(runtime: ToolRuntime) -> Command:
    """Write the coarse sweep of bleed hypotheses (3 types x 8 regions x 4 volumes) to /hypotheses.json, split by region agent.

    The region agents test their share and add finer volumes where the coarse scores point.
    """
    plan = _plan()
    doc = {
        "count": len(plan),
        "id_format": "<type>-<side><lobe>-<volume mL>; epi=epidural, sub=subdural, iph=intraparenchymal; e.g. epi-LT-20 = epidural, L temporal, 20 mL",
        "coarse_volumes_ml": list(COARSE_VOLUMES),
        "all_volumes_ml": list(physics.VOLUMES),
        "lead": [NO_BLEED],
        **{lobe: [h["id"] for h in plan if h["agent"] == lobe] for lobe in physics.LOBES},
    }
    # One line per key, so a region agent reads its whole share in one read_file.
    body = ",\n".join(f" {json.dumps(k)}: {json.dumps(v)}" for k, v in doc.items())
    await backend.awrite(PLAN_FILE, "{\n" + body + "\n}")
    sims = await asyncio.to_thread(_queued, plan)
    _emit(runtime, {"type": "sims_reset", "sims": sims})
    return _reply(runtime, f"Wrote the coarse sweep ({len(plan)} hypotheses, {len(plan) // 4} per region agent) to {PLAN_FILE}, plus '{NO_BLEED}' for you.", sims={"reset": sims})


async def _admit(runtime: ToolRuntime, ids: list[str], known: dict) -> tuple[list[dict], list[str], list[str]]:
    """Add valid ids that are not on the grid yet (a refinement or a challenger). Returns (new sims, their ids, ids over the limit)."""
    fresh = [i for i in ids if i in _BY_ID and i not in known]
    room = max(0, min(MAX_NEW_PER_CALL, MAX_HYPOTHESES - len(known)))
    fresh, over = fresh[:room], fresh[room:]
    added = await asyncio.to_thread(_queued, [_BY_ID[i] for i in fresh], **{"pass": "review" if _caller(runtime) == "skeptic" else "refine"})
    if added:
        _emit(runtime, {"type": "sims", "sims": added})
    return added, fresh, over


@tool
async def forward_sim(hypothesis_ids: list[str], note: str, runtime: ToolRuntime) -> Command:
    """Simulate the reading each hypothesis would produce on the head model (pyEIT forward model, precomputed lookup).

    Ids outside the coarse sweep are allowed: that is how you refine (e.g. add epi-LT-15, epi-LT-20, epi-LT-30
    after epi-LT-25 scored well). At most 12 new ids per call.

    Args:
        hypothesis_ids: e.g. ["epi-LT-10", "epi-LT-25"]. Pass everything for this pass in one call.
        note: A few words on why these, shown to the medic. E.g. "coarse sweep" or "refining epidural L temporal around 25 mL".
    """
    who = _caller(runtime)
    hypothesis_ids = _ids(hypothesis_ids)
    known = {s["id"]: s for s in runtime.state.get("sims", [])}
    bad = [i for i in hypothesis_ids if i != NO_BLEED and i not in _BY_ID]
    added, fresh, over = await _admit(runtime, hypothesis_ids, known)

    healthy = physics.null_reading()
    patches, lines = list(added), []
    for hid in hypothesis_ids:
        if hid == NO_BLEED:
            lines.append(f"{NO_BLEED}: healthy-head reading")
        if hid not in known and hid not in fresh:
            continue
        sim = physics.lookup(hid)
        drop = [c - h for c, h in zip(sim["coil_db"], healthy["coil_db"], strict=True)]
        k = min(range(8), key=lambda i: drop[i])
        lines.append(f"{hid}: largest change at {physics.SPOT_NAMES[k]}, coil {drop[k]:+.2f} dB, NIR {sim['nir'][k] - healthy['nir'][k]:+.3f}")
        if hid in known and known[hid]["status"] == "done":
            continue  # already scored against this scan; nothing to re-run
        patch = {"id": hid, "status": "running", "progress": 0.5, "by": who, "note": note, "reading": sim}
        patches.append(patch)
        _emit(runtime, {"type": "sims", "sims": [patch]})
        await asyncio.sleep(SIM_PACE_S)
    text = f"Simulated {len(lines)} readings. Score them with fit_score.\n" + "\n".join(lines)
    if bad:
        text += f"\nNot valid hypothesis ids, skipped: {bad}"
    if over:
        text += f"\nOver the limit ({MAX_NEW_PER_CALL} new per call, {MAX_HYPOTHESES} in total), skipped: {over}"
    return _reply(runtime, text, sims=patches)


@tool
async def fit_score(hypothesis_ids: list[str], runtime: ToolRuntime) -> Command:
    """Score how well each simulated reading matches the scan: 0 (no match) to 1 (perfect). Weak-contact spots count less.

    May be called in the same turn as forward_sim with the same ids.

    Args:
        hypothesis_ids: the ids passed to forward_sim (or ["no-bleed"]). Pass them all in one call.
    """
    scan = runtime.state.get("reading")
    if not scan:
        return _reply(runtime, "No scan loaded. Call read_scan first.")
    hypothesis_ids = _ids(hypothesis_ids)
    known = {s["id"]: s for s in runtime.state.get("sims", [])}
    # Called alongside forward_sim, this may see a new id before forward_sim's update lands.
    added, fresh, _ = await _admit(runtime, hypothesis_ids, known)
    known |= {s["id"]: s for s in added}
    patches, scored, update, skipped = list(added), [], {}, []
    if SIM_PACE_S and any(i in known for i in hypothesis_ids):
        await asyncio.sleep(0.35)  # let the "running" wave from forward_sim show first
    for hid in hypothesis_ids:
        if hid == NO_BLEED:  # the healthy head needs no forward_sim first
            update["null_fit"] = round(physics.fit(physics.null_reading(), scan), 2)
            scored.append((update["null_fit"], NO_BLEED))
            continue
        if hid not in known:
            skipped.append(hid)
            continue
        if known[hid]["status"] == "done":
            scored.append((known[hid]["score"], hid))
            continue
        sim = physics.lookup(hid)
        score = round(physics.fit(sim, scan), 2)
        scored.append((score, hid))
        patch = {"id": hid, "status": "done", "progress": 1, "score": score, "by": _caller(runtime), "reading": sim, "misfit": physics.residuals(sim, scan)}
        patches.append(patch)
        _emit(runtime, {"type": "sims", "sims": [patch]})
        await asyncio.sleep(SIM_PACE_S)
    scored.sort(reverse=True)
    text = "Fit scores, best first:\n" + "\n".join(f"{hid} {score:.2f}" for score, hid in scored)
    if skipped:
        text += f"\nNot valid hypothesis ids, skipped: {skipped}"
    return _reply(runtime, text, sims=patches, **update)


async def _preview(runtime: ToolRuntime, hypothesis_id: str) -> dict:
    h = _BY_ID[hypothesis_id]
    preview = {"hypothesis_id": hypothesis_id, "map": await asyncio.to_thread(physics.hypothesis_map, h["type"], h["region"], h["volume_ml"], 64)}
    _emit(runtime, {"type": "preview", "preview": preview})
    return preview


@tool
async def rank_fits(runtime: ToolRuntime) -> Command:
    """Collect the region agents' result files, rank every scored hypothesis against the no-bleed model, and apply the decision rule.

    Call once all four region agents are back. If the rule's outcome is a bleed, the best fit's map goes on the dashboard.
    """
    state = runtime.state
    sims = state.get("sims", [])
    left = sum(s["status"] != "done" for s in sims)
    findings = {lobe: await _read_json(sims_file(lobe)) for lobe in physics.LOBES}
    missing = [lobe for lobe, f in findings.items() if f is None]
    if not sims or left or state.get("null_fit") is None or missing:
        return _reply(
            runtime,
            f"Not ready: {left} hypotheses unscored; no-bleed {'scored' if state.get('null_fit') is not None else 'not scored'}; "
            f"result files missing or unreadable for: {missing or 'none'}. Re-run those region agents.",
        )
    d = decide(sims, state["null_fit"])
    notes = "\n".join(f"{lobe} ({f.get('tested', '?')} tested): {f.get('finding', 'no note')}" for lobe, f in findings.items())
    by_region: dict[str, dict] = {}
    for s in sorted(sims, key=lambda s: -s["score"]):
        by_region.setdefault(s["region"], s)
    table = "\n".join(f"{r}: {s['id']} {s['score']:.2f}" for r, s in by_region.items())
    weak = weak_spots(state.get("reading"))
    if d["status"] == "uncertain" and weak and not state.get("rescans"):
        nxt = f"Next: contact was weak at spots {weak} ({', '.join(physics.SPOT_NAMES[i] for i in weak)}). Call request_rescan(spots={weak}) before proposing a result."
    else:
        nxt = f"Next: propose '{d['status']}' with submit_result" + (f" (hypothesis_id {d['best']['id']})." if d["status"] == "bleed" else ".")
    update = {"preview": await _preview(runtime, d["best"]["id"])} if d["status"] == "bleed" else {}
    if (state.get("reading") or {}).get("later_scan"):  # an acceptance may have come in since the scan was read
        update["accepted_by"] = await _accepted_handoff(runtime)
    prefs = await _oncall_preferences(runtime) if d["status"] == "bleed" else ""
    return _reply(runtime, f"{describe(d)}\nBest fit per region:\n{table}\nRegion agents' notes (from /sims/*.json):\n{notes}\n{nxt}{prefs}", **update)


# ---- Memory: who accepted this patient, and what each clinician wants in a pre-alert --


async def _accepted_handoff(runtime: ToolRuntime) -> dict | None:
    """The newest hand-off for this patient that a clinician accepted, on any thread: the dashboard runs a re-scan on a new one."""
    if not photon.enabled():
        return None
    try:
        items = await runtime.store.asearch(photon.HANDOFFS_NS, filter={"patient_id": _patient(runtime)}, limit=100)
    except Exception:  # noqa: BLE001 - an unreadable record names nobody, so nothing is sent
        return None
    accepted = [i.value for i in items if (i.value.get("reply") or {}).get("decision") == "accept" and i.value.get("to") and not i.value.get("simulated")]
    if not accepted:
        return None
    r = max(accepted, key=lambda r: r["reply"].get("at") or "")
    return {k: r[k] for k in ("thread_id", "to", "space_id", "agent_user_id", "reply")}


async def _oncall_preferences(runtime: ToolRuntime) -> str:
    """The on-call clinician's standing preferences, for rank_fits to pass on: the pre-alert follows them without an extra turn."""
    who = await _on_call(runtime) if photon.enabled() else None
    notes = (await _read_text(notes_path(who["handle"])) or "").strip() if who else ""
    if not notes:
        return ""
    return f"\nThe on-call clinician's standing preferences for pre-alerts (follow them in send_prealert's message; the safety wording still applies):\n{notes}"


def rescan_update_text(patient_id: str, before: dict, after: dict, minutes: int) -> str:
    """The re-scan update, built from the two approved results only, never from the model's wording.
    A change under 5 mL is within the model's resolution (skills/head-model), so it is "no change"."""

    def finding(r: dict) -> str:
        return f"{r['type']}, {r['region']}, about {r['volume_ml']} mL" if r["status"] == "bleed" else "no bleed seen"

    if before["status"] == "bleed" and after["status"] == "clear":
        body = f"The bleed pattern seen then ({finding(before)}) is no longer seen. This does not rule a bleed out."
    elif before["status"] == "bleed" and after["status"] == "bleed":
        change = after["volume_ml"] - before["volume_ml"]
        trend = f"Growing, +{change} mL" if change >= 5 else f"Smaller, {change} mL" if change <= -5 else "No change in size (within 5 mL)"
        where = "same place" if after["region"] == before["region"] else f"now {after['region']}, was {before['region']}"
        body = f"Then: {finding(before)}. Now: {finding(after)}. {trend}, {where}."
    else:
        body = f"Then: {finding(before)}. Now: {finding(after)}."
    return f"Lucid update, patient {patient_id}: re-scan {minutes} min after the first scan.\n{body}\n{photon.SAFETY_LINE}"


def _update_to(state: dict, status: str) -> dict | None:
    """Who an approved result will update: the clinician who accepted this patient, on a later scan with a bleed or clear result."""
    if status in ("bleed", "clear") and (state.get("reading") or {}).get("later_scan") and photon.enabled():
        return state.get("accepted_by")
    return None


def _updated(state: dict) -> bool:
    """This scan already went to the clinician who accepted the patient, as an update."""
    return (state.get("handoff") or {}).get("kind") == "update"


async def _send_rescan_update(runtime: ToolRuntime, who: dict, result: dict, base: dict) -> tuple[dict | None, str]:
    """Text the clinician who accepted this patient the change since `base`, the first scan. Returns (state hand-off or None, a note for the model)."""
    thread_id = runtime.config["configurable"]["thread_id"]
    item = await runtime.store.aget(photon.HANDOFFS_NS, who["thread_id"])
    if item is None or (item.value.get("reply") or {}).get("decision") != "accept":
        return None, ""  # they declined since, or the record is gone: nothing goes out
    rec, to = item.value, photon.mask(item.value["to"])
    taken = (datetime.fromisoformat(runtime.state["reading"]["taken_at"]) - datetime.fromisoformat(base["taken_at"])).total_seconds()
    text = rescan_update_text(_patient(runtime), base["result"], result, max(1, round(taken / 60)))
    try:
        mid = await photon.send_text(rec["space_id"], rec["agent_user_id"], text, f"update:{thread_id}:{runtime.tool_call_id}")
    except (photon.PhotonError, httpx.HTTPError) as e:
        return None, f" The update to the clinician who accepted this patient ({to}) could not be sent ({e}). Tell the medic."
    sent_at, msg = datetime.now(UTC).isoformat(timespec="seconds"), {"id": mid, "kind": "update", "status": "queued"}
    report = await _read_text(REPORT_FILE) or ""
    fresh = (await runtime.store.aget(photon.HANDOFFS_NS, who["thread_id"])).value  # the bridge writes delivery status here too
    await runtime.store.aput(photon.HANDOFFS_NS, who["thread_id"], {**fresh, "messages": [*fresh.get("messages", []), msg]})
    if who["thread_id"] != thread_id:
        # A re-scan on a new thread gets its own record: the dashboard shows the update, and the clinician's next text reaches this scan.
        await runtime.store.aput(
            photon.HANDOFFS_NS,
            thread_id,
            {**{k: rec[k] for k in ("patient_id", "to", "space_id", "agent_user_id", "reply")}, "thread_id": thread_id, "sent_at": sent_at, "message": text,
             "report": report, "transport": (runtime.state.get("reading") or {}).get("transport"),
             "medic_notes": (runtime.state.get("reading") or {}).get("medic_notes"), "status": "sent", "messages": [msg], "call": None,
             "simulated": False, "update_of": who["thread_id"]},
        )
    handoff = {"to": to, "message": text, "report": report, "sent_at": sent_at, "simulated": False, "channel": "imessage", "status": "sent", "reply": rec.get("reply"), "kind": "update"}
    return handoff, f" The clinician who accepted this patient ({to}) was texted the change since the first scan:\n{text}\nDo not call send_prealert; tell the medic they were told."


@tool
async def render_map(hypothesis_id: str, runtime: ToolRuntime) -> Command:
    """Render one hypothesis as a small 2D heatmap on the dashboard, e.g. when the medic asks to see an alternative fit."""
    h = _BY_ID.get(hypothesis_id)
    if h is None:
        return _reply(runtime, f"Unknown hypothesis '{hypothesis_id}'.")
    return _reply(
        runtime,
        f"Map for {hypothesis_id} ({h['type']}, {h['region']}, {h['volume_ml']} mL) is on the dashboard.",
        preview=await _preview(runtime, hypothesis_id),
    )


# ---- Result and handoff (both pause for the medic) ------------------------


def check_result(args: dict, state: dict) -> tuple[str | None, dict]:
    """Why a proposed result is not allowed (None if it is), plus the rule outcome."""
    sims = state.get("sims", [])
    d = decide(sims, state.get("null_fit"))
    status = args.get("status")
    if not sims or sum(s["status"] == "done" for s in sims) < len(sims) or state.get("null_fit") is None:
        return "Not every hypothesis is scored yet (including 'no-bleed'). Finish the simulations first.", d
    if REVIEW_FILE not in (state.get("files") or {}):
        return f"No second opinion on file ({REVIEW_FILE}). Have the skeptic review the leading finding first.", d
    if status not in ("bleed", "clear", "uncertain"):
        return "status must be 'bleed', 'clear' or 'uncertain'.", d
    # The agent may be more cautious than the rule, never less.
    if status != "uncertain" and status != d["status"]:
        return f"The decision rule does not allow '{status}' here.\n{describe(d)}\nPropose '{d['status']}' or 'uncertain'.", d
    if status == "bleed":
        # A tie with the best fit in the same place is the same finding.
        pick = next((s for s in sims if s["id"] == args.get("hypothesis_id")), None)
        best = d["best"]
        if pick is None or (pick["region"], pick["type"]) != (best["region"], best["type"]) or pick["score"] < best["score"]:
            return f"For 'bleed', hypothesis_id must be the best fit.\n{describe(d)}", d
        d = {**d, "best": pick}
    return None, d


def result_needs_approval(request) -> bool:
    """Pause for the medic only when the proposal is valid; invalid ones bounce straight back to the agent."""
    return check_result(request.tool_call["args"], request.state)[0] is None


def describe_result(tool_call, state, _runtime) -> str:
    """What the approval card says. On a later scan it also names the clinician the approval will update."""
    args = tool_call["args"]
    _, d = check_result(args, state)
    b = d["best"]
    if args["status"] == "bleed":
        lo, hi = d["volume_range"]
        size = f"about {b['volume_ml']} mL" if lo == hi else f"about {b['volume_ml']} mL (range {lo}-{hi})"
        text = f"Mark this scan Bleed likely?\n{b['type'].capitalize()}, {b['region']}, {size}. Fit {b['score']:.2f}."
    elif args["status"] == "clear":
        text = f"Mark this scan No bleed seen?\nThe no-bleed model fits at {d['null_fit']:.2f}; no bleed hypothesis comes close. Screening aid, not a diagnosis."
    else:
        return f"Mark this scan Uncertain, re-scan?\n{d['reason']}"
    who = _update_to(state, args["status"])
    return text + (f"\nThe clinician who accepted this patient ({photon.mask(who['to'])}) will be told." if who else "")


@tool
async def submit_result(status: str, hypothesis_id: str, summary: str, runtime: ToolRuntime) -> Command:
    """Record the screening result for this scan. Pauses for the medic's approval first.

    Region, volume and confidence are taken from the scored simulations, not from you.

    Args:
        status: "bleed" (bleed likely), "clear" (no bleed seen) or "uncertain" (re-scan).
        hypothesis_id: The best-fit hypothesis id for "bleed"; otherwise "".
        summary: One short sentence for the record.
    """
    state = runtime.state
    error, d = check_result({"status": status, "hypothesis_id": hypothesis_id}, state)
    if error:
        return _reply(runtime, error)
    best = d["best"]
    scan = dict(state["scan"])
    if status == "bleed":
        scan |= {"status": "bleed", "region": best["region"], "volume_ml": best["volume_ml"], "confidence": best["score"]}
        scan["map"] = await asyncio.to_thread(physics.hypothesis_map, best["type"], best["region"], best["volume_ml"], 64)
    elif status == "clear":
        scan |= {"status": "clear", "region": "None", "volume_ml": 0, "confidence": d["null_fit"]}
    else:
        scan |= {"status": "uncertain", "region": best["region"], "volume_ml": 0, "confidence": best["score"]}
    result = {k: scan[k] for k in ("status", "region", "volume_ml", "confidence")} | {"type": best["type"], "summary": summary}
    _emit(runtime, {"type": "scan", "scan": scan})

    note = ""
    path = baseline_path(_patient(runtime))
    base = await _read_json(path)  # read before this result can become the baseline: an update compares with an earlier scan
    if status != "uncertain" and base is None:
        await backend.awrite(path, json.dumps({**state["reading"], "result": result}))
        note = " Saved as this patient's baseline for later re-scans."
    update = {}
    who = _update_to(state, status) if base else None  # the card named them, so the medic's approval covers this text
    handoff, told = await _send_rescan_update(runtime, who, result, base) if who else (None, "")
    if handoff:
        update["handoff"] = handoff
        _emit(runtime, {"type": "handoff", "handoff": handoff})
    elif status == "bleed" and photon.enabled():
        # The pre-alert card is built without I/O, so the recipient is looked up now; the card and the send both use it.
        update["recipient"] = await _on_call(runtime)
    _archive(runtime, result)
    return _reply(runtime, f"Medic approved. Recorded: {status}.{note}{told}", scan=scan, preview=None, **update)


def _archive(runtime: ToolRuntime, result: dict) -> None:
    """The approved case to the Atlas archive, in the background so the agent never waits on it. No map: it is dense, and rebuilt from type, region and volume."""
    if not atlas.enabled():
        return
    doc = {"patient_id": _patient(runtime), "thread_id": runtime.config["configurable"]["thread_id"], **result, "reading": runtime.state.get("reading"), "archived_at": datetime.now(UTC)}
    task = asyncio.create_task(atlas.archive_scan(doc))
    _archiving.add(task)
    task.add_done_callback(_archiving.discard)


async def _on_call(runtime: ToolRuntime) -> dict | None:
    """Who is on call now, from the roster in the Store. None if nobody is, or the roster cannot be read."""
    try:
        items = await runtime.store.asearch(photon.ONCALL_NS, limit=100)
    except Exception:  # noqa: BLE001 - an unreadable roster names nobody, so nothing is sent
        return None
    return photon.pick_oncall([i.value for i in items])


def prealert_needs_approval(request) -> bool:
    """No card once the accepting clinician was updated: the tool refuses then, without sending anything."""
    state = request.state
    return (state.get("scan") or {}).get("status") == "bleed" and REPORT_FILE in (state.get("files") or {}) and not _updated(state)


def describe_prealert(tool_call, state, _runtime) -> str:
    scan = state.get("scan") or {}
    fit = f"best fit ({scan.get('region')}, {scan.get('volume_ml')} mL)"
    if not photon.enabled():
        return (
            f"Send pre-alert to {tool_call['args'].get('destination', 'the receiving trauma center')}?\n"
            f"Includes the map, {fit}, the scan log and the hand-off report."
        )
    who = state.get("recipient")
    if who is None:
        return "Nobody is on call, so no pre-alert will be sent.\nApprove to record that, then hand off by radio."
    return (
        f"Send pre-alert to the on-call clinician ({photon.mask(who['handle'])}) by iMessage?\n"
        f"The map image and the pre-alert text with the {fit}. They can reply to accept, decline or ask about the scan."
    )


async def _prealert_imessage(runtime: ToolRuntime, message: str, report: str, sent_at: str) -> tuple[dict, str]:
    """Send the map image, then the text, to the clinician the medic approved. Returns the state hand-off and the reply for the model.

    The full record (handle, Photon ids, message ids) goes to the Store, where the replies bridge and the dashboard follow it.
    """
    state = runtime.state
    thread_id = runtime.config["configurable"]["thread_id"]
    patient = _patient(runtime)
    transport = (state.get("reading") or {}).get("transport")
    text = photon.prealert_text(message, patient, transport)
    named = state.get("recipient")  # whom the approval card named; nobody else gets it
    entry = await runtime.store.aget(photon.ONCALL_NS, named["handle"]) if named else None
    who = entry.value if entry and entry.value.get("active") else None
    record = {
        "thread_id": thread_id,
        "patient_id": patient,
        "to": who and who["handle"],
        "space_id": who and who["space_id"],
        "agent_user_id": who and who["agent_user_id"],
        "sent_at": sent_at,
        "message": text,
        "report": report,
        "transport": transport,
        "medic_notes": (state.get("reading") or {}).get("medic_notes"),
        "status": "no_one_on_call",
        "messages": [],
        "reply": None,
        "call": None,
        "simulated": False,
    }
    if who is None:
        reply = "Medic approved, but no clinician is on call, so nothing was sent. Tell the medic nobody is on call and to hand off by radio."
    else:
        key, to = f"prealert:{thread_id}:{runtime.tool_call_id}", photon.mask(who["handle"])
        note = ""
        try:  # the map first; if it cannot go, the text still does
            shown = {k: v for k, v in state["scan"].items() if k != "map"} | {"patient_id": patient}
            png = await asyncio.to_thread(physics.map_png, state["scan"]["map"], shown)
            mid = await photon.send_image(who["space_id"], who["agent_user_id"], png, "lucid-map.png", f"{key}:image")
            record["messages"].append({"id": mid, "kind": "image", "status": "queued"})
        except (photon.PhotonError, httpx.HTTPError, KeyError) as e:
            note = f" The map image could not be sent ({e})."
        try:
            mid = await photon.send_text(who["space_id"], who["agent_user_id"], text, f"{key}:text")
            record["messages"].append({"id": mid, "kind": "text", "status": "queued"})
            record["status"] = "sent"
            reply = (
                f"Medic approved. Pre-alert sent by iMessage to the on-call clinician ({to}): "
                f"{'the map image and ' if len(record['messages']) == 2 else ''}the text. Queued; delivery is not confirmed yet.{note} "
                "The clinician can reply to accept, decline or ask about the scan. The report itself was not texted; it stays on record. "
                "Tell the medic it went to the on-call clinician by iMessage and that their reply will show here."
            )
        except (photon.PhotonError, httpx.HTTPError) as e:
            record |= {"status": "failed", "error": str(e)}
            reply = f"Medic approved, but the pre-alert could not be sent ({e}). Tell the medic it did not go out and to hand off by radio."
    await runtime.store.aput(photon.HANDOFFS_NS, thread_id, record)
    handoff = {
        "to": photon.mask(record["to"]) if record["to"] else None,
        "message": text,
        "report": report,
        "sent_at": sent_at,
        "simulated": False,
        "channel": "imessage",
        "status": record["status"],
        "reply": None,
    }
    return handoff, reply


@tool
async def send_prealert(destination: str, message: str, runtime: ToolRuntime) -> Command:
    """Hand off: send a pre-alert with the approved result and map to the on-call clinician by iMessage, with /report.md on record. Pauses for the medic's approval first.

    Only after a "bleed" result has been approved and /report.md has been written.

    Args:
        destination: Who receives it, e.g. "the on-call clinician".
        message: The pre-alert text. First sentence: the finding alone (type, side and region, about N mL, fit). Then the transport
            (e.g. "Medic 12, ETA about 12 min."), the patient id once at the end, and that this is a screening aid pending CT.
            No timestamps, never a name.
    """
    if (runtime.state.get("scan") or {}).get("status") != "bleed":
        return _reply(runtime, "No approved 'bleed' result on record, so there is nothing to hand off.")
    if _updated(runtime.state):
        return _reply(runtime, "Not sent: the clinician who accepted this patient was already texted the change since the first scan. No new pre-alert is needed; tell the medic they were told.")
    report = await _read_text(REPORT_FILE)
    if report is None:
        return _reply(runtime, f"Write the hand-off report to {REPORT_FILE} first; it goes out with the pre-alert.")
    sent_at = datetime.now(UTC).isoformat(timespec="seconds")
    if not photon.enabled():  # no Photon line set up: the hand-off is recorded, not sent
        handoff = {"to": destination, "message": message, "report": report, "sent_at": sent_at, "simulated": True}
        _emit(runtime, {"type": "handoff", "handoff": handoff})
        return _reply(runtime, "Medic approved. Recorded as simulated: no hospital link is configured, so nothing was sent to anyone. Tell the medic exactly that.", handoff=handoff)
    handoff, reply = await _prealert_imessage(runtime, message, report, sent_at)
    _emit(runtime, {"type": "handoff", "handoff": handoff})
    return _reply(runtime, reply, handoff=handoff)


# ---- The receiving clinician's answer --------------------------------------

CLINICIAN_PREFIX = "[Receiving clinician"
_CALL_DECISION = re.compile(r"^\[Receiving clinician, phone call\]\s*decision:\s*(accept|decline|none)\b", re.I)
_DECISION_WORD = re.compile(r"\b(accept(?:ed|ing)?|declin(?:e|ed|ing))\b", re.I)
_NEGATED = re.compile(r"\b(not|no|never|don'?t|doesn'?t|can'?t|cannot|won'?t|unable to)\s+(\w+\s+)?$", re.I)


def _content(m) -> str:
    c = m.content if hasattr(m, "content") else m.get("content")
    return c if isinstance(c, str) else " ".join(b.get("text", "") for b in c or [] if isinstance(b, dict))


def latest_clinician_message(messages: list) -> str | None:
    """The newest message the bridge put on the thread from the receiving clinician (text or call), or None."""
    return next((t for t in (_content(m) for m in reversed(messages) if getattr(m, "type", None) == "human") if t.startswith(CLINICIAN_PREFIX)), None)


def clinician_decision(message: str) -> tuple[str | None, str]:
    """(decision, via) as the clinician's own words give it. A call carries `decision:`, derived in code from their turns;
    a text must say accept or decline itself, once, not negated. Anything else is no decision."""
    if m := _CALL_DECISION.match(message):
        return (None if m[1].lower() == "none" else m[1].lower()), "call"
    body = message.split("]", 1)[-1]
    found = set()
    for w in _DECISION_WORD.finditer(body):
        if _NEGATED.search(body[: w.start()]):
            return None, "imessage"
        found.add("accept" if w[0].lower().startswith("accept") else "decline")
    return (found.pop() if len(found) == 1 else None), "imessage"


@tool
async def record_reply(decision: str, note: str, runtime: ToolRuntime) -> Command:
    """Record the receiving clinician's answer to the pre-alert. Only when their latest message accepts or declines in so many words.

    Args:
        decision: "accept" or "decline".
        note: One short sentence from their message worth keeping for the medic, or "".
    """
    decision = decision.strip().lower()
    latest = latest_clinician_message(runtime.state.get("messages") or [])
    thread_id = runtime.config["configurable"]["thread_id"]
    item = await runtime.store.aget(photon.HANDOFFS_NS, thread_id)
    if latest is None or item is None:
        return _reply(runtime, "No pre-alert reply from a clinician on this thread, so there is nothing to record.")
    found, via = clinician_decision(latest)
    if decision not in ("accept", "decline") or found != decision:
        return _reply(runtime, f"Not recorded: the clinician's latest message does not clearly say {decision.upper() or 'ACCEPT or DECLINE'}. Ask them to reply ACCEPT or DECLINE.")
    reply = {"decision": decision, "note": note.strip(), "at": datetime.now(UTC).isoformat(timespec="seconds"), "via": via}
    fresh = await runtime.store.aget(photon.HANDOFFS_NS, thread_id)  # the bridge writes delivery status into the same record
    existing = (fresh or item).value.get("reply") or {}
    if via == "call" and existing.get("via") == "imessage":
        return _reply(runtime, "A decision already arrived by iMessage; keep that decision and recap the call without changing it.")
    await runtime.store.aput(photon.HANDOFFS_NS, thread_id, {**(fresh or item).value, "reply": reply})
    text = f"Recorded: the clinician {decision}s the patient ({via}). The medic sees it on the dashboard. Confirm it to the clinician in one sentence."
    if not runtime.state.get("handoff"):
        return _reply(runtime, text)
    handoff = {**runtime.state["handoff"], "reply": reply}
    _emit(runtime, {"type": "handoff", "handoff": handoff})
    return _reply(runtime, text, handoff=handoff)


@tool
async def remember_preference(note: str, runtime: ToolRuntime) -> Command:
    """Remember a standing preference the receiving clinician stated about how they want pre-alerts or answers, for their next pre-alert.

    Format or content only (e.g. "always include contact quality"), never a clinical threshold: the decision rule is not theirs to change.

    Args:
        note: The preference as one short line, in their words where possible.
    """
    item = await runtime.store.aget(photon.HANDOFFS_NS, runtime.config["configurable"]["thread_id"])
    line = " ".join(note.split())
    if item is None or not item.value.get("to") or latest_clinician_message(runtime.state.get("messages") or []) is None or not line:
        return _reply(runtime, "Not remembered: no clinician has written on this thread.")
    path = notes_path(item.value["to"])  # the handle stays out of the model's context
    old = await _read_text(path) or ""
    if line.lower() not in old.lower():
        await backend.awrite(path, old + ("\n" if old and not old.endswith("\n") else "") + f"- {line}\n")
    return _reply(runtime, f"Remembered for this clinician's next pre-alert: {line}. Confirm it to them in one short sentence.")


LEAD_TOOLS = [read_scan, recall_baseline, plan_hypotheses, forward_sim, fit_score, rank_fits, request_rescan, render_map, submit_result, send_prealert, record_reply, remember_preference]
SIM_TOOLS = [forward_sim, fit_score]
