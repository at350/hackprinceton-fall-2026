"""The agent's file system: three places behind one set of file tools."""

from deepagents.backends import CompositeBackend, FilesystemBackend, StateBackend, StoreBackend

from lucid.config import SKILLS_DIR

backend = CompositeBackend(
    # Scratch files for one scan (/hypotheses.json, /sims/<region>.json) live in the thread.
    default=StateBackend(),
    routes={
        # Skills are plain files in agent/skills, read-only in practice.
        "/skills/": FilesystemBackend(root_dir=SKILLS_DIR, virtual_mode=True),
        # Patient baselines live in the LangGraph Store (SQLite), across threads and restarts.
        "/patients/": StoreBackend(namespace=lambda _rt: ("lucid", "patients")),
    },
)


def baseline_path(patient_id: str) -> str:
    return f"/patients/{patient_id}/baseline.json"
