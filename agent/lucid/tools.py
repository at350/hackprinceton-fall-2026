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
from lucid.config import DEFAULT_PATIENT, DEFAULT_SCAN, HYPOTHESIS_TARGET, SIM_PACE_S
from lucid.decision import decide, describe

NO_BLEED = "no-bleed"
_BY_ID = {h["id"]: h for h in physics.all_hypotheses()}
physics.lookup(next(iter(_BY_ID)))  # load the lookup table at import, not inside the event loop


def _reply(runtime: ToolRuntime, text: str, **update) -> Command:
    return Command(update={**update, "messages": [ToolMessage(text, tool_call_id=runtime.tool_call_id)]})


def _emit(runtime: ToolRuntime, event: dict) -> None:
    """Send a live event to the dashboard (stream mode "custom")."""
    runtime.stream_writer(event)


async def _read_json(path: str) -> dict | None:
    res = await backend.aread(path)
    if res.error or not res.file_data:
        return None
    try:
        return json.loads(res.file_data["content"])
    except (json.JSONDecodeError, TypeError):
        return None


def _patient(runtime: ToolRuntime) -> str:
    return runtime.state.get("patient_id") or DEFAULT_PATIENT


# ---- Scan -----------------------------------------------------------------


@tool
async def read_scan(runtime: ToolRuntime) -> Command:
    """Read the current scan from the device: 8 spots around the head, each with a coil signal (dB) and a NIR value.

    Call this first. Returns a table of the readings and how each differs from a healthy head.
    """
    case = runtime.state.get("scan_id") or DEFAULT_SCAN
    if case not in physics.MOCK_CASES:
        return _reply(runtime, f"Unknown scan '{case}'. Available: {', '.join(physics.MOCK_CASES)}.")
    # No hardware yet: the mock device returns the 15-minutes-later scan once a baseline exists.
    has_baseline = await _read_json(baseline_path(_patient(runtime))) is not None
    scan = physics.mock_scan(case, rescan=has_baseline)
    scan["taken_at"] = datetime.now(UTC).isoformat(timespec="seconds")
    scan["patient_id"] = _patient(runtime)

    healthy = physics.null_reading()
    peaks = physics.spot_peaks(scan)
    spots = [
        {"index": s["index"], "name": s["name"], "angle": s["angle"], "state": "done" if s["quality"] == "good" else "rescan", "peak": peaks[s["index"]]}
        for s in scan["spots"]
    ]
    scan_view = {
        "spot": 7,
        "done": True,
        "map": await asyncio.to_thread(physics.likelihood_map, scan, 64),
        "status": "pending",  # no result is stated before the medic approves it
        "region": "None",
        "volume_ml": 0,
        "confidence": 0,
    }
    _emit(runtime, {"type": "scan", "scan": scan_view, "spots": spots})

    rows = [
        f"{s['index']} {s['name']:<11} coil {s['coil_db']:.2f} dB ({s['coil_db'] - healthy['coil_db'][s['index']]:+.2f})  "
        f"NIR {s['nir']:.3f} ({s['nir'] - healthy['nir'][s['index']]:+.3f})  contact {s['quality']}"
        for s in scan["spots"]
    ]
    text = (
        f"Scan for patient {scan['patient_id']} taken {scan['taken_at']}. Change from a healthy head in brackets.\n"
        + "\n".join(rows)
        + ("\nAn earlier scan of this patient is on file: call recall_baseline." if has_baseline else "\nNo earlier scan of this patient is on file.")
    )
    return _reply(runtime, text, reading=scan, scan=scan_view, spots=spots, sims={"reset": []}, null_fit=None, handoff=None)


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


# ---- Hypotheses and simulation --------------------------------------------


def _plan(focus: list[str]) -> list[dict]:
    """About HYPOTHESIS_TARGET hypotheses: every volume in the focus regions, a coarse sweep elsewhere."""
    regions = list(physics.REGION_ANGLE)
    focus = [r for r in regions if r in focus][:3]
    rest = [r for r in regions if r not in focus]
    dense = len(focus) * len(physics.BLEED_TYPES) * len(physics.VOLUMES)
    sweeps = {2: (10, 30), 3: (10, 25, 40), 4: (5, 15, 25, 35)}
    k = min(sweeps, key=lambda n: abs(dense + len(rest) * len(physics.BLEED_TYPES) * n - HYPOTHESIS_TARGET))
    return [
        _BY_ID[physics.hypothesis_id(t, region, v)]
        for region in regions
        for t in physics.BLEED_TYPES
        for v in (physics.VOLUMES if region in focus else sweeps[k])
    ]


@tool
async def plan_hypotheses(focus_regions: list[str], rationale: str, runtime: ToolRuntime) -> Command:
    """Write about 100 bleed hypotheses (type x region x volume 5-40 mL) to /hypotheses.json.

    Args:
        focus_regions: 0 to 3 regions to test at every volume, picked from the scan
            (e.g. ["L temporal", "L parietal"]). All other regions get a coarse sweep.
            Region names: "L frontal", "R frontal", "L temporal", "R temporal",
            "L parietal", "R parietal", "L occipital", "R occipital".
        rationale: One sentence on why these regions, for the record.
    """
    unknown = [r for r in focus_regions if r not in physics.REGION_ANGLE]
    if unknown:
        return _reply(runtime, f"Unknown region(s): {unknown}. Use names like 'L temporal'.")
    plan = _plan(focus_regions)
    by_lobe = {lobe: [h["id"] for h in plan if h["agent"] == lobe] for lobe in physics.LOBES}
    doc = {
        "count": len(plan),
        "id_format": "<type>-<side><lobe>-<volume mL>; epi=epidural, sub=subdural, iph=intraparenchymal; e.g. epi-LT-20 = epidural, L temporal, 20 mL",
        "focus_regions": focus_regions,
        "rationale": rationale,
        "lead": [NO_BLEED],
        **by_lobe,
    }
    # One line per key, so a region agent reads its whole share in one read_file.
    body = ",\n".join(f" {json.dumps(k)}: {json.dumps(v)}" for k, v in doc.items())
    await backend.awrite("/hypotheses.json", "{\n" + body + "\n}")

    def build() -> list[dict]:
        return [
            {**h, "status": "queued", "score": 0, "progress": 0, "map": physics.hypothesis_map(h["type"], h["region"], h["volume_ml"], 32)}
            for h in plan
        ]

    sims = await asyncio.to_thread(build)
    _emit(runtime, {"type": "sims_reset", "sims": sims})
    counts = ", ".join(f"{lobe} {len(ids)}" for lobe, ids in by_lobe.items())
    return _reply(
        runtime,
        f"Wrote {len(plan)} hypotheses to /hypotheses.json ({counts}), plus '{NO_BLEED}' for you to test yourself.",
        sims={"reset": sims},
    )


def _known(ids: list[str], sims: list[dict]) -> tuple[list[str], list[str]]:
    planned = {s["id"] for s in sims} | {NO_BLEED}
    return [i for i in ids if i in planned], [i for i in ids if i not in planned]


@tool
async def forward_sim(hypothesis_ids: list[str], runtime: ToolRuntime) -> Command:
    """Simulate the reading each hypothesis would produce on the head model (pyEIT forward model, precomputed lookup).

    Args:
        hypothesis_ids: ids from /hypotheses.json, e.g. ["epi-LT-20", "sub-LT-25"]. Pass your whole share in one call.
    """
    ids, bad = _known(hypothesis_ids, runtime.state.get("sims", []))
    healthy = physics.null_reading()
    patches, lines = [], []
    for hid in ids:
        if hid == NO_BLEED:
            lines.append(f"{NO_BLEED}: healthy-head reading")
            continue
        sim = physics.lookup(hid)
        drop = [c - h for c, h in zip(sim["coil_db"], healthy["coil_db"], strict=True)]
        k = min(range(8), key=lambda i: drop[i])
        lines.append(f"{hid}: largest change at {physics.SPOT_NAMES[k]}, coil {drop[k]:+.2f} dB, NIR {sim['nir'][k] - healthy['nir'][k]:+.3f}")
        patch = {"id": hid, "status": "running", "progress": 0.5}
        patches.append(patch)
        _emit(runtime, {"type": "sims", "sims": [patch]})
        await asyncio.sleep(SIM_PACE_S)
    text = f"Simulated {len(ids)} readings. Score them with fit_score.\n" + "\n".join(lines)
    if bad:
        text += f"\nNot in /hypotheses.json, skipped: {bad}"
    return _reply(runtime, text, sims=patches)


@tool
async def fit_score(hypothesis_ids: list[str], runtime: ToolRuntime) -> Command:
    """Score how well each simulated reading matches the scan: 0 (no match) to 1 (perfect). Weak-contact spots count less.

    Args:
        hypothesis_ids: ids already passed to forward_sim. Pass them all in one call.
    """
    scan = runtime.state.get("reading")
    if not scan:
        return _reply(runtime, "No scan loaded. Call read_scan first.")
    ids, bad = _known(hypothesis_ids, runtime.state.get("sims", []))
    patches, scored, update = [], [], {}
    for hid in ids:
        if hid == NO_BLEED:  # the healthy head needs no forward_sim first
            update["null_fit"] = round(physics.fit(physics.null_reading(), scan), 2)
            scored.append((update["null_fit"], NO_BLEED))
            continue
        score = round(physics.fit(physics.lookup(hid), scan), 2)
        scored.append((score, hid))
        patch = {"id": hid, "status": "done", "progress": 1, "score": score}
        patches.append(patch)
        _emit(runtime, {"type": "sims", "sims": [patch]})
        await asyncio.sleep(SIM_PACE_S)
    scored.sort(reverse=True)
    text = "Fit scores, best first:\n" + "\n".join(f"{hid} {score:.2f}" for score, hid in scored)
    if bad:
        text += f"\nNot in /hypotheses.json, skipped: {bad}"
    return _reply(runtime, text, sims=patches, **update)


@tool
def rank_fits(runtime: ToolRuntime) -> str:
    """Rank every scored hypothesis against the no-bleed model and apply the decision rule. Call once all region agents are back."""
    sims = runtime.state.get("sims", [])
    left = sum(s["status"] != "done" for s in sims)
    if not sims or left or runtime.state.get("null_fit") is None:
        return f"Not ready: {left} hypotheses unscored, no-bleed {'scored' if runtime.state.get('null_fit') is not None else 'not scored'}."
    d = decide(sims, runtime.state["null_fit"])
    by_region: dict[str, dict] = {}
    for s in sorted(sims, key=lambda s: -s["score"]):
        by_region.setdefault(s["region"], s)
    table = "\n".join(f"{r}: {s['id']} {s['score']:.2f}" for r, s in by_region.items())
    return f"{describe(d)}\nBest fit per region:\n{table}"


@tool
async def render_map(hypothesis_id: str, runtime: ToolRuntime) -> Command:
    """Render one hypothesis as a small 2D heatmap for the dashboard, so the medic sees what they are asked to approve."""
    h = _BY_ID.get(hypothesis_id)
    if h is None:
        return _reply(runtime, f"Unknown hypothesis '{hypothesis_id}'.")
    preview = {"hypothesis_id": hypothesis_id, "map": await asyncio.to_thread(physics.hypothesis_map, h["type"], h["region"], h["volume_ml"], 64)}
    _emit(runtime, {"type": "preview", "preview": preview})
    return _reply(runtime, f"Map for {hypothesis_id} ({h['type']}, {h['region']}, {h['volume_ml']} mL) is on the dashboard.", preview=preview)


# ---- Result and handoff (both pause for the medic) ------------------------


def check_result(args: dict, state: dict) -> tuple[str | None, dict]:
    """Why a proposed result is not allowed (None if it is), plus the rule outcome."""
    sims = state.get("sims", [])
    d = decide(sims, state.get("null_fit"))
    status = args.get("status")
    if not sims or sum(s["status"] == "done" for s in sims) < len(sims) or state.get("null_fit") is None:
        return "Not every hypothesis is scored yet (including 'no-bleed'). Finish the simulations first.", d
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
        summary: One or two plain sentences for the medic on what the fit shows.
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
    return (request.state.get("scan") or {}).get("status") == "bleed"


def describe_prealert(tool_call, state, _runtime) -> str:
    scan = state.get("scan") or {}
    return (
        f"Send pre-alert to {tool_call['args'].get('destination', 'the receiving trauma center')}?\n"
        f"Includes the map, best fit ({scan.get('region')}, {scan.get('volume_ml')} mL) and the scan log."
    )


@tool
async def send_prealert(destination: str, message: str, runtime: ToolRuntime) -> Command:
    """Hand off: send a pre-alert with the approved result, map and scan log to the receiving hospital. Pauses for the medic's approval first.

    Only after a "bleed" result has been approved and recorded.

    Args:
        destination: Who receives it, e.g. "the receiving trauma center".
        message: The pre-alert text: finding, region, approximate volume, fit, and that this is a screening aid pending CT.
    """
    if (runtime.state.get("scan") or {}).get("status") != "bleed":
        return _reply(runtime, "No approved 'bleed' result on record, so there is nothing to hand off.")
    handoff = {"to": destination, "message": message, "sent_at": datetime.now(UTC).isoformat(timespec="seconds"), "simulated": True}
    _emit(runtime, {"type": "handoff", "handoff": handoff})
    return _reply(runtime, f"Medic approved. Pre-alert sent to {destination} (simulated: no hospital link in this build).", handoff=handoff)


LEAD_TOOLS = [read_scan, recall_baseline, plan_hypotheses, forward_sim, fit_score, rank_fits, render_map, submit_result, send_prealert]
REGION_TOOLS = [forward_sim, fit_score]
