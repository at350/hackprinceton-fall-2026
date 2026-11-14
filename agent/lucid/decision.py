"""The decision rule, as code. The tools enforce it; the agent may only be more cautious."""

from lucid.config import MIN_FIT, MIN_MARGIN


def decide(sims: list[dict], null_fit: float | None) -> dict:
    """Apply the rule to the scored simulations.

    Returns status ("bleed" | "clear" | "uncertain"), the best fit, its strongest
    rival (best fit in a different region), the no-bleed fit, and the reason.
    """
    done = sorted((s for s in sims if s["status"] == "done"), key=lambda s: -s["score"])
    if not done or null_fit is None:
        return {"status": "uncertain", "best": None, "rival": None, "null_fit": null_fit, "reason": "Not everything is scored yet."}
    best = done[0]
    rival = next((s for s in done if s["region"] != best["region"]), None)
    rival_score = rival["score"] if rival else 0.0
    # Same type and region within the margin: the same finding at other sizes.
    close = [s["volume_ml"] for s in done if s["region"] == best["region"] and s["type"] == best["type"] and best["score"] - s["score"] <= MIN_MARGIN]
    out = {"best": best, "rival": rival, "null_fit": null_fit, "volume_range": [min(close), max(close)]}

    if null_fit >= MIN_FIT and null_fit - best["score"] >= MIN_MARGIN:
        return {**out, "status": "clear", "reason": f"No-bleed model fits at {null_fit:.2f}; best bleed hypothesis only {best['score']:.2f}."}
    if best["score"] < MIN_FIT:
        return {**out, "status": "uncertain", "reason": f"Best fit {best['score']:.2f} is below {MIN_FIT:.2f}."}
    runner_up = max(rival_score, null_fit)
    if best["score"] - runner_up < MIN_MARGIN:
        return {**out, "status": "uncertain", "reason": f"Best fit {best['score']:.2f} is within {MIN_MARGIN:.2f} of a different explanation ({runner_up:.2f})."}
    return {**out, "status": "bleed", "reason": f"Best fit {best['score']:.2f} beats every other region and the no-bleed model by at least {MIN_MARGIN:.2f}."}


def describe(d: dict) -> str:
    """One compact block the agent can read."""
    b, r = d["best"], d["rival"]
    lines = [f"Rule outcome: {d['status']}. {d['reason']}"]
    if b:
        lines.append(f"Best fit: {b['id']} ({b['type']}, {b['region']}, {b['volume_ml']} mL) score {b['score']:.2f}; volumes within the margin: {d['volume_range'][0]}-{d['volume_range'][1]} mL.")
    if r:
        lines.append(f"Best fit in another region: {r['id']} ({r['region']}) score {r['score']:.2f}.")
    if d["null_fit"] is not None:
        lines.append(f"No-bleed model: {d['null_fit']:.2f}.")
    return "\n".join(lines)
