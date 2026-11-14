"""Lucid's tools. Each does one narrow thing and keeps the dashboard state current.

Tools return a short text for the model and write the full data to state, so the
model never has to carry maps or tables through its context.
"""

import asyncio
import json
from datetime import UTC, datetime

from langchain.tools import ToolRuntime, tool
from langchain_core.messages import ToolMessage
from langgraph.types import Command

from lucid import physics
from lucid.backend import backend, baseline_path
from lucid.config import COARSE_VOLUMES, DEFAULT_PATIENT, DEFAULT_SCAN, MAX_HYPOTHESES, MAX_NEW_PER_CALL, SIM_PACE_S
from lucid.decision import decide, describe

NO_BLEED = "no-bleed"
SCAN_FILE = "/scan.json"
PLAN_FILE = "/hypotheses.json"
REVIEW_FILE = "/review.md"
REPORT_FILE = "/report.md"
_BY_ID = {h["id"]: h for h in physics.all_hypotheses()}
physics.lookup(next(iter(_BY_ID)))  # load the lookup table at import, not inside the event loop


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
        "region": "None",
        "volume_ml": 0,
        "confidence": 0,
    }
    _emit(runtime, {"type": "scan", "scan": view, "spots": spots, "reading": scan})
    # The region agents and the skeptic read the scan from this file.
    doc = {
        "patient_id": scan["patient_id"],
        "taken_at": scan["taken_at"],
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
    if case not in physics.MOCK_CASES:
        return _reply(runtime, f"Unknown scan '{case}'. Available: {', '.join(physics.MOCK_CASES)}.")
    # No hardware yet: the mock device returns the 15-minutes-later scan once a baseline exists.
    has_baseline = await _read_json(baseline_path(_patient(runtime))) is not None
    scan = physics.mock_scan(case, rescan=has_baseline)
    scan |= {"taken_at": datetime.now(UTC).isoformat(timespec="seconds"), "patient_id": _patient(runtime), "later_scan": has_baseline}
    for stale in (*map(sims_file, physics.LOBES), REVIEW_FILE, REPORT_FILE):  # from an earlier scan on this thread
        await backend.adelete(stale)
    update = await _publish_scan(runtime, scan)
    text = (
        f"Scan for patient {scan['patient_id']} taken {scan['taken_at']}. Change from a healthy head in brackets.\n"
        + "\n".join(_scan_rows(scan))
        + ("\nAn earlier scan of this patient is on file." if has_baseline else "\nNo earlier scan of this patient is on file.")
    )
    return _reply(runtime, text, **update, null_fit=None, handoff=None, preview=None, rescans=0)


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
    scan = physics.mock_scan(old["case"], rescan=old.get("later_scan", False), reseat=tuple(spots))
    scan |= {"taken_at": datetime.now(UTC).isoformat(timespec="seconds"), "patient_id": old["patient_id"], "later_scan": old.get("later_scan", False)}
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
    return _reply(runtime, f"{describe(d)}\nBest fit per region:\n{table}\nRegion agents' notes (from /sims/*.json):\n{notes}\n{nxt}", **update)


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
    """What the approval card says."""
    args = tool_call["args"]
    _, d = check_result(args, state)
    b = d["best"]
    if args["status"] == "bleed":
        lo, hi = d["volume_range"]
        size = f"about {b['volume_ml']} mL" if lo == hi else f"about {b['volume_ml']} mL (range {lo}-{hi})"
        return f"Mark this scan Bleed likely?\n{b['type'].capitalize()}, {b['region']}, {size}. Fit {b['score']:.2f}."
    if args["status"] == "clear":
        return f"Mark this scan No bleed seen?\nThe no-bleed model fits at {d['null_fit']:.2f}; no bleed hypothesis comes close. Screening aid, not a diagnosis."
    return f"Mark this scan Uncertain, re-scan?\n{d['reason']}"


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
    if status != "uncertain" and await _read_json(path) is None:
        await backend.awrite(path, json.dumps({**state["reading"], "result": result}))
        note = " Saved as this patient's baseline for later re-scans."
    return _reply(runtime, f"Medic approved. Recorded: {status}.{note}", scan=scan, preview=None)


def prealert_needs_approval(request) -> bool:
    return (request.state.get("scan") or {}).get("status") == "bleed" and REPORT_FILE in (request.state.get("files") or {})


def describe_prealert(tool_call, state, _runtime) -> str:
    scan = state.get("scan") or {}
    return (
        f"Send pre-alert to {tool_call['args'].get('destination', 'the receiving trauma center')}?\n"
        f"Includes the map, best fit ({scan.get('region')}, {scan.get('volume_ml')} mL), the scan log and the hand-off report."
    )


@tool
async def send_prealert(destination: str, message: str, runtime: ToolRuntime) -> Command:
    """Hand off: send a pre-alert with the approved result, map, scan log and /report.md to the receiving hospital. Pauses for the medic's approval first.

    Only after a "bleed" result has been approved and /report.md has been written.

    Args:
        destination: Who receives it, e.g. "the receiving trauma center".
        message: The pre-alert text: finding, region, approximate volume, fit, and that this is a screening aid pending CT.
    """
    if (runtime.state.get("scan") or {}).get("status") != "bleed":
        return _reply(runtime, "No approved 'bleed' result on record, so there is nothing to hand off.")
    report = await _read_text(REPORT_FILE)
    if report is None:
        return _reply(runtime, f"Write the hand-off report to {REPORT_FILE} first; it goes out with the pre-alert.")
    handoff = {"to": destination, "message": message, "report": report, "sent_at": datetime.now(UTC).isoformat(timespec="seconds"), "simulated": True}
    _emit(runtime, {"type": "handoff", "handoff": handoff})
    return _reply(runtime, f"Medic approved. Pre-alert and report sent to {destination} (simulated: no hospital link in this build).", handoff=handoff)


LEAD_TOOLS = [read_scan, recall_baseline, plan_hypotheses, forward_sim, fit_score, rank_fits, request_rescan, render_map, submit_result, send_prealert]
SIM_TOOLS = [forward_sim, fit_score]
