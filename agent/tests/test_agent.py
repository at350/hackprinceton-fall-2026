"""Decision rule, approval gate and state merging on the three mock scans. No model calls.

Run from agent/:  .venv/bin/python tests/test_agent.py
"""

import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lucid import physics  # noqa: E402
from lucid.decision import decide  # noqa: E402
from lucid.state import merge_sims  # noqa: E402
from lucid.tools import _plan, check_result, result_needs_approval  # noqa: E402


def scored(case: str, focus: list[str], rescan: bool = False) -> tuple[list[dict], float]:
    scan = physics.mock_scan(case, rescan=rescan)
    sims = [{**h, "status": "done", "score": round(physics.fit(physics.lookup(h["id"]), scan), 2)} for h in _plan(focus)]
    return sims, round(physics.fit(physics.null_reading(), scan), 2)


def test_plan_is_about_100():
    for focus in ([], ["L temporal"], ["L temporal", "L parietal"], ["L temporal", "L parietal", "L frontal"]):
        assert 90 <= len(_plan(focus)) <= 110, (focus, len(_plan(focus)))


def test_bleed():
    sims, null = scored("temporal_bleed", ["L temporal", "L parietal"])
    d = decide(sims, null)
    assert d["status"] == "bleed" and d["best"]["region"] == "L temporal" and d["best"]["type"] == "epidural", d


def test_rescan_shows_growth():
    first = decide(*scored("temporal_bleed", ["L temporal"]))["best"]["volume_ml"]
    later = decide(*scored("temporal_bleed", ["L temporal"], rescan=True))["best"]["volume_ml"]
    assert later > first, (first, later)


def test_clear():
    assert decide(*scored("clear", []))["status"] == "clear"


def test_uncertain():
    assert decide(*scored("uncertain", ["L temporal", "L parietal"]))["status"] == "uncertain"


def test_agent_cannot_claim_more_than_the_rule():
    sims, null = scored("uncertain", ["L temporal", "L parietal"])
    state = {"sims": sims, "null_fit": null}
    best = decide(sims, null)["best"]["id"]
    for args in ({"status": "bleed", "hypothesis_id": best}, {"status": "clear", "hypothesis_id": ""}):
        assert check_result(args, state)[0] is not None
        # An invalid proposal must not reach the medic.
        assert not result_needs_approval(SimpleNamespace(tool_call={"args": args}, state=state))
    ok = {"status": "uncertain", "hypothesis_id": ""}
    assert check_result(ok, state)[0] is None
    assert result_needs_approval(SimpleNamespace(tool_call={"args": ok}, state=state))


def test_nothing_is_proposed_before_everything_is_scored():
    sims, null = scored("temporal_bleed", ["L temporal"])
    sims[0] = {**sims[0], "status": "running"}
    assert check_result({"status": "uncertain", "hypothesis_id": ""}, {"sims": sims, "null_fit": null})[0] is not None


def test_merge_never_moves_a_sim_backwards():
    done = [{"id": "a", "status": "done", "score": 0.9}, {"id": "b", "status": "queued", "score": 0}]
    stale = [{"id": "a", "status": "queued", "score": 0}, {"id": "b", "status": "done", "score": 0.4}]
    merged = {s["id"]: s for s in merge_sims(done, stale)}
    assert merged["a"]["status"] == "done" and merged["a"]["score"] == 0.9
    assert merged["b"]["status"] == "done" and merged["b"]["score"] == 0.4
    assert merge_sims(done, {"reset": []}) == []


if __name__ == "__main__":
    tests = [f for name, f in sorted(globals().items()) if name.startswith("test_")]
    for t in tests:
        t()
        print("ok ", t.__name__)
    print(len(tests), "passed")
