"""The Lucid deep agent: a triage lead, four region agents, a skeptic, and three points where it waits for the medic."""

import time

from deepagents import create_deep_agent
from langchain.agents.middleware import AgentMiddleware, TodoListMiddleware

from lucid import physics
from lucid.backend import backend
from lucid.config import MODEL, REGION_MODEL, make_model
from lucid.prompts import LEAD_PROMPT, REGION_PROMPT, SKEPTIC_PROMPT
from lucid.state import LucidState
from lucid.tools import (
    LEAD_TOOLS,
    REPORT_FILE,
    SIM_TOOLS,
    describe_prealert,
    describe_rescan,
    describe_result,
    prealert_needs_approval,
    rescan_needs_approval,
    result_needs_approval,
)


class ActivityLog(AgentMiddleware):
    """Stream what a subagent is doing to the dashboard, as it does it.

    The lead's steps reach the UI through its messages; a subagent's messages stay
    in its own context, so its tool calls and replies are sent as custom events.
    """

    def __init__(self, agent: str) -> None:
        self.agent = agent

    def _emit(self, runtime, **item) -> None:
        runtime.stream_writer({"type": "activity", "item": {"agent": self.agent, "at": int(time.time() * 1000), **item}})

    async def awrap_tool_call(self, request, handler):
        call = request.tool_call
        args = call["args"]
        ids = args.get("hypothesis_ids") or []
        self._emit(request.runtime, tool=call["name"], path=args.get("file_path"), note=args.get("note"), ids=ids)
        return await handler(request)

    def after_model(self, state, runtime):
        last = state["messages"][-1]
        if getattr(last, "type", "") == "ai" and not getattr(last, "tool_calls", None):
            text = last.content if isinstance(last.content, str) else " ".join(b.get("text", "") for b in last.content if isinstance(b, dict))
            if text.strip():
                self._emit(runtime, tool=None, text=text.strip())
        return None


class TodoProgress(AgentMiddleware):
    """Tick the lead's to-do list forward from the tool calls it makes.

    The lead writes the plan and may update it alongside its other calls. Which step
    it is on also follows from what it just called, so when it does not update the
    list itself, this moves it at the moment the work starts.
    """

    # tool call -> index of the to-do that is in progress once that call goes out
    STEP = {"plan_hypotheses": 1, "task": 2, "rank_fits": 3, "request_rescan": 4, "submit_result": 4, "send_prealert": 4}

    def after_model(self, state, runtime):
        last = state["messages"][-1]
        calls = getattr(last, "tool_calls", None) or []
        names = [c["name"] for c in calls]
        steps = [self.STEP[n] for n in names if n in self.STEP]
        # In turn 1 the list is still inside the write_todos call that creates it.
        written = next((c["args"].get("todos") for c in calls if c["name"] == "write_todos"), None)
        todos = written if isinstance(written, list) and written else state.get("todos") or []
        if not todos or not steps:
            return None
        # Forward only: after a re-scan the simulations run again, but the plan does not rewind.
        reached = max((i for i, t in enumerate(todos) if t.get("status") != "pending"), default=0)
        at = min(max(*steps, reached), len(todos) - 1)
        new = [{**t, "status": "completed" if i < at else "in_progress" if i == at else "pending"} for i, t in enumerate(todos)]
        # The tools of this turn may run for a while (the region agents); tell the dashboard now.
        runtime.stream_writer({"type": "todos", "todos": new})
        return {"todos": new} if not written and new != state.get("todos") else None


class CloseOut(AgentMiddleware):
    """Tidy the dashboard state when the lead finishes a turn after the medic has decided.

    Ticks off the plan (saves a model call whose only job would be that) and, if
    the medic rejected the proposed result, marks the scan as having no result
    and removes the report drafted for it.
    """

    def after_agent(self, state, runtime):
        verdicts = [m for m in state["messages"] if getattr(m, "type", "") == "tool" and m.name == "submit_result"]
        if not verdicts:
            return None
        update = {}
        todos = state.get("todos") or []
        if any(t["status"] != "completed" for t in todos):
            update["todos"] = [{**t, "status": "completed"} for t in todos]
        scan = state.get("scan")
        if scan and scan["status"] == "pending" and verdicts[-1].status == "error":  # the gate reports a rejection as an error
            update["scan"] = {**scan, "status": "rejected"}
            update["preview"] = None
            if REPORT_FILE in (state.get("files") or {}):
                update["files"] = {REPORT_FILE: None}
        return update or None


def subagent(name: str, description: str, system_prompt: str) -> dict:
    return {
        "name": name,
        "description": description,
        "system_prompt": system_prompt,
        "tools": SIM_TOOLS,
        "model": make_model(REGION_MODEL),
        "middleware": [ActivityLog(name)],
        "interrupt_on": {},  # subagents only simulate; nothing of theirs needs approval
    }


region_agents = [
    subagent(
        region,
        f"Searches the {region} bleed hypotheses (left and right {region}) from /hypotheses.json against the scan: "
        f"a coarse pass, then finer volumes where it points. Writes /sims/{region}.json and returns its finding.",
        REGION_PROMPT.format(region=region),
    )
    for region in physics.LOBES
]

skeptic = subagent(
    "skeptic",
    "Second opinion. Tries to break the leading finding in /sims/*.json by testing rival hypotheses against /scan.json. Writes /review.md and returns a verdict.",
    SKEPTIC_PROMPT,
)

agent = create_deep_agent(
    model=make_model(MODEL),
    tools=LEAD_TOOLS,
    system_prompt=LEAD_PROMPT,
    subagents=[*region_agents, skeptic],
    skills=["/skills/"],
    backend=backend,
    middleware=[TodoListMiddleware(), TodoProgress(), CloseOut()],
    state_schema=LucidState,
    # The agent stops for the medic before a re-scan, before a result is stated, and before any handoff.
    interrupt_on={
        "request_rescan": {"allowed_decisions": ["approve", "reject"], "description": describe_rescan, "when": rescan_needs_approval},
        "submit_result": {"allowed_decisions": ["approve", "reject"], "description": describe_result, "when": result_needs_approval},
        "send_prealert": {"allowed_decisions": ["approve", "reject"], "description": describe_prealert, "when": prealert_needs_approval},
    },
    name="lucid",
)
