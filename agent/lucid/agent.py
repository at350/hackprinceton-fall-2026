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



class CloseTodos(AgentMiddleware):
    """Tick off the plan when the lead finishes a turn after the medic has decided.

    Saves a model call whose only job would be to mark the last step done.
    """

    def after_agent(self, state, runtime):
        todos = state.get("todos") or []
        decided = any(getattr(m, "type", "") == "tool" and m.name == "submit_result" for m in state["messages"])
        if decided and any(t["status"] != "completed" for t in todos):
            return {"todos": [{**t, "status": "completed"} for t in todos]}
        return None


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
    middleware=[TodoListMiddleware(), CloseTodos()],
    state_schema=LucidState,
    # The medic approves before a result is stated and before any handoff.
    interrupt_on={
        "submit_result": {"allowed_decisions": ["approve", "reject"], "description": describe_result, "when": result_needs_approval},
        "send_prealert": {"allowed_decisions": ["approve", "reject"], "description": describe_prealert, "when": prealert_needs_approval},
    },
    name="lucid",
)
