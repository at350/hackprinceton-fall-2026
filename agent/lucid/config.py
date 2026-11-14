"""All tunables in one place."""

import os
from pathlib import Path

from langchain.chat_models import init_chat_model

# Trace every run to LangSmith (LANGSMITH_API_KEY comes from .env).
os.environ.setdefault("LANGSMITH_TRACING", "true")
os.environ.setdefault("LANGSMITH_PROJECT", "lucid")

# The model. One line to switch providers, e.g. for the Amazon track:
#   LUCID_MODEL="bedrock_converse:us.anthropic.claude-sonnet-4-5-20250929-v1:0"  (needs langchain-aws)
MODEL = os.getenv("LUCID_MODEL", "anthropic:claude-sonnet-5")
# Region agents do a narrow, mechanical job, so they run on the small fast model.
REGION_MODEL = os.getenv("LUCID_REGION_MODEL", "anthropic:claude-haiku-5-5")


def make_model(name: str):
    """Build a chat model from a "provider:model" name.

    Extended thinking is off on Anthropic models: every step here is a short,
    scripted tool turn, and thinking adds 5-8 s to each one.
    """
    kwargs = {"thinking": {"type": "disabled"}} if name.startswith("anthropic:") else {}
    return init_chat_model(name, **kwargs)


AGENT_DIR = Path(__file__).resolve().parent.parent
SKILLS_DIR = AGENT_DIR / "skills"
# Patient baselines (LangGraph Store on SQLite). Survives server restarts.
STORE_DB = os.getenv("LUCID_STORE_DB", str(AGENT_DIR / "data" / "lucid_store.sqlite"))

# Decision rule (also written out for the agent in skills/head-model).
MIN_FIT = 0.80  # best fit below this: uncertain
MIN_MARGIN = 0.05  # best fit must beat every other region, and the no-bleed model, by this much

HYPOTHESIS_TARGET = 100  # how many hypotheses the lead plans per scan

# The lookup table answers instantly. Sim events are paced so a person can watch
# the grid fill; set to 0 for tests.
SIM_PACE_S = float(os.getenv("LUCID_SIM_PACE_S", "0.06"))

DEFAULT_SCAN = "temporal_bleed"
DEFAULT_PATIENT = "demo-patient"
