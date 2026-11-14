"""Decision rule, approval gates and state handling on the three mock scans. No model calls.

Run from agent/:  .venv/bin/python tests/test_agent.py
"""

import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from langchain_core.messages import AIMessage  # noqa: E402

from lucid import physics  # noqa: E402
from lucid.agent import TodoProgress  # noqa: E402
from lucid.decision import decide  # noqa: E402
from lucid.state import merge_sims  # noqa: E402
from lucid.tools import REVIEW_FILE, _ids, _plan, check_result, rescan_needs_approval, result_needs_approval  # noqa: E402

REVIEWED = {REVIEW_FILE: {"content": "Verdict: holds"}}


def scored(scan: dict, extra: tuple[str, ...] = ()) -> tuple[list[dict], float]:
    """The coarse sweep (plus any refinements) scored against a scan, as the region agents leave it."""
    hyps = _plan() + [physics.parse_hypothesis_id(i) for i in extra]
    sims = [{**h, "status": "done", "score": round(physics.fit(physics.lookup(h["id"]), scan), 2)} for h in hyps]
    return sims, round(physics.fit(physics.null_reading(), scan), 2)


def request(args: dict, state: dict):
    return SimpleNamespace(tool_call={"args": args}, state=state)


def test_coarse_sweep_covers_every_region_and_type():
    plan = _plan()
    assert len(plan) == 96 and len({h["id"] for h in plan}) == 96
    for lobe in physics.LOBES:
        assert sum(h["agent"] == lobe for h in plan) == 24


def test_bleed():
    d = decide(*scored(physics.mock_scan("temporal_bleed")))
    assert d["status"] == "bleed" and d["best"]["region"] == "L temporal" and d["best"]["type"] == "epidural", d


def test_rescan_15_min_later_shows_growth():
    refine = ("epi-LT-15", "epi-LT-25", "epi-LT-35")
    first = decide(*scored(physics.mock_scan("temporal_bleed"), refine))["volume_range"]
    later = decide(*scored(physics.mock_scan("temporal_bleed", rescan=True), refine))["volume_range"]
    assert sum(later) > sum(first), (first, later)


def test_clear():
    assert decide(*scored(physics.mock_scan("clear"), ("iph-LO-05", "iph-RO-05")))["status"] == "clear"


def test_uncertain_until_the_weak_spots_are_rescanned():
    first = physics.mock_scan("uncertain")
    assert decide(*scored(first))["status"] == "uncertain"
    again = decide(*scored(physics.mock_scan("uncertain", reseat=(5, 6))))
    assert again["status"] == "bleed" and again["best"]["region"] == "L parietal", again


def test_rescan_is_offered_once_and_only_for_weak_spots():
    state = {"reading": physics.mock_scan("uncertain"), "rescans": 0}
    assert rescan_needs_approval(request({"spots": [5, 6]}, state))
    assert not rescan_needs_approval(request({"spots": [2]}, state))  # contact was good there
    assert not rescan_needs_approval(request({"spots": []}, state))
    assert not rescan_needs_approval(request({"spots": [5, 6]}, {**state, "rescans": 1}))
    assert not rescan_needs_approval(request({"spots": [6]}, {"reading": physics.mock_scan("temporal_bleed")}))


def test_agent_cannot_claim_more_than_the_rule():
    sims, null = scored(physics.mock_scan("uncertain"))
    state = {"sims": sims, "null_fit": null, "files": REVIEWED}
    best = decide(sims, null)["best"]["id"]
    for args in ({"status": "bleed", "hypothesis_id": best}, {"status": "clear", "hypothesis_id": ""}):
        assert check_result(args, state)[0] is not None
        # An invalid proposal must not reach the medic.
        assert not result_needs_approval(request(args, state))
    ok = {"status": "uncertain", "hypothesis_id": ""}
    assert check_result(ok, state)[0] is None
    assert result_needs_approval(request(ok, state))


def test_no_result_without_a_second_opinion():
    sims, null = scored(physics.mock_scan("temporal_bleed"))
    args = {"status": "bleed", "hypothesis_id": decide(sims, null)["best"]["id"]}
    assert check_result(args, {"sims": sims, "null_fit": null, "files": {}})[0] is not None
    assert check_result(args, {"sims": sims, "null_fit": null, "files": REVIEWED})[0] is None


def test_a_rival_found_by_the_skeptic_changes_the_outcome():
    sims, null = scored(physics.mock_scan("temporal_bleed"))
    best = decide(sims, null)["best"]
    rival = {**physics.parse_hypothesis_id("epi-RT-25"), "status": "done", "score": best["score"] - 0.02, "pass": "review"}
    assert decide([*sims, rival], null)["status"] == "uncertain"


def test_nothing_is_proposed_before_everything_is_scored():
    sims, null = scored(physics.mock_scan("temporal_bleed"))
    sims[0] = {**sims[0], "status": "running"}
    assert check_result({"status": "uncertain", "hypothesis_id": ""}, {"sims": sims, "null_fit": null, "files": REVIEWED})[0] is not None


def test_merge_never_moves_a_sim_backwards():
    done = [{"id": "a", "status": "done", "score": 0.9}, {"id": "b", "status": "queued", "score": 0}]
    stale = [{"id": "a", "status": "queued", "score": 0}, {"id": "b", "status": "done", "score": 0.4}, {"id": "c", "status": "queued", "score": 0}]
    merged = {s["id"]: s for s in merge_sims(done, stale)}
    assert merged["a"]["status"] == "done" and merged["a"]["score"] == 0.9
    assert merged["b"]["status"] == "done" and merged["b"]["score"] == 0.4
    assert "c" in merged  # a refinement another agent added
    assert merge_sims(done, {"reset": []}) == []


def test_ids_are_normalised():
    assert _ids(["epi-LT-5", "epi-LT-05", " sub-RF-20 ", "no-bleed"]) == ["epi-LT-05", "sub-RF-20", "no-bleed"]


def test_todos_follow_the_tool_calls():
    todos = [{"content": c, "status": "pending"} for c in "abcde"]
    step = lambda *names: TodoProgress().after_model({"todos": todos, "messages": [AIMessage("", tool_calls=[{"name": n, "args": {}, "id": n} for n in names])]}, None)  # noqa: E731
    assert [t["status"] for t in step("task", "fit_score")["todos"]] == ["completed", "completed", "in_progress", "pending", "pending"]
    assert [t["status"] for t in step("submit_result")["todos"]][3:] == ["completed", "in_progress"]
    assert step("write_todos", "read_scan") is None  # the lead is writing the list itself this turn
    assert step("read_file") is None


if __name__ == "__main__":
    tests = [f for name, f in sorted(globals().items()) if name.startswith("test_")]
    for t in tests:
        t()
        print("ok ", t.__name__)
    print(len(tests), "passed")
