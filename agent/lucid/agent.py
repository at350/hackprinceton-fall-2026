"""The Lucid deep agent: a triage lead, four region agents, and two approval gates."""

from deepagents import create_deep_agent
from langchain.agents.middleware import AgentMiddleware, TodoListMiddleware

from lucid import physics
from lucid.backend import backend
from lucid.config import MODEL, REGION_MODEL, make_model
from lucid.prompts import LEAD_PROMPT, REGION_PROMPT
from lucid.state import LucidState
from lucid.tools import (
    LEAD_TOOLS,
    REGION_TOOLS,
    describe_prealert,
    describe_result,
    prealert_needs_approval,
    result_needs_approval,
)



class CloseOut(AgentMiddleware):
    """Tidy the dashboard state when the lead finishes a turn after the medic has decided.

    Ticks off the plan (saves a model call whose only job would be that) and, if
    the medic rejected the proposed result, marks the scan as having no result.
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
        return update or None


region_agents = [
    {
        "name": region,
        "description": f"Tests the {region} bleed hypotheses (left and right {region}) from /hypotheses.json against the scan and returns its three best fits.",
        "system_prompt": REGION_PROMPT.format(region=region),
        "tools": REGION_TOOLS,
        "model": make_model(REGION_MODEL),
        "interrupt_on": {},  # region agents only simulate; nothing of theirs needs approval
    }
    for region in physics.LOBES
]

agent = create_deep_agent(
    model=make_model(MODEL),
    tools=LEAD_TOOLS,
    system_prompt=LEAD_PROMPT,
    subagents=region_agents,
    skills=["/skills/"],
    backend=backend,
    middleware=[TodoListMiddleware(), CloseOut()],
    state_schema=LucidState,
    # The medic approves before a result is stated and before any handoff.
    interrupt_on={
        "submit_result": {"allowed_decisions": ["approve", "reject"], "description": describe_result, "when": result_needs_approval},
        "send_prealert": {"allowed_decisions": ["approve", "reject"], "description": describe_prealert, "when": prealert_needs_approval},
    },
    name="lucid",
)
