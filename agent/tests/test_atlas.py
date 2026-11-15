"""The Atlas case archive: what an approved scan writes, and that the archive never holds up or breaks a scan. No network, no model calls.

Run from agent/:  .venv/bin/python tests/test_atlas.py
"""

import asyncio
import os
import sys
import time
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lucid import atlas, tools  # noqa: E402
from test_memory import PATIENT, args_for, fake_files, patched, photon_env, result_state, runtime, text_of  # noqa: E402


@contextmanager
def atlas_env(url: str | None):
    """Set (or clear) MONGODB_ATLAS_URL for one test, with a fresh client and ../.env left unread."""
    saved, load = os.environ.get("MONGODB_ATLAS_URL"), atlas._load_env
    atlas._load_env, atlas._client = (lambda: None), None
    if url:
        os.environ["MONGODB_ATLAS_URL"] = url
    else:
        os.environ.pop("MONGODB_ATLAS_URL", None)
    try:
        yield
    finally:
        atlas._load_env, atlas._client = load, None
        if saved is None:
            os.environ.pop("MONGODB_ATLAS_URL", None)
        else:
            os.environ["MONGODB_ATLAS_URL"] = saved


def run_submit(status: str, archive) -> tuple:
    """submit_result on a first scan with the archive replaced, waiting for the background write before the loop closes."""
    rt = runtime(result_state("clear" if status == "clear" else "bleed", later=False, accepted=False))
    args = args_for(rt.state, status)

    async def go():
        with fake_files({}), photon_env(False), patched(atlas, archive_scan=archive):
            cmd = await tools.submit_result.coroutine(status=status, hypothesis_id=args["hypothesis_id"], summary="s", runtime=rt)
            await asyncio.gather(*tools._archiving, return_exceptions=True)
            return cmd

    return asyncio.run(go()), rt


def test_disabled_archives_nothing():
    docs = []

    async def keep(doc):
        docs.append(doc)

    with atlas_env(None):
        assert not atlas.enabled()
        cmd, _ = run_submit("bleed", keep)
        assert docs == [] and not tools._archiving
        assert "Medic approved. Recorded: bleed." in text_of(cmd) and cmd.update["scan"]["status"] == "bleed"
        asyncio.run(atlas.archive_scan({"x": 1}))  # a no-op, not an error


def test_each_status_archives_one_case_record():
    for status in ("bleed", "clear", "uncertain"):
        docs = []

        async def keep(doc):
            docs.append(doc)

        with atlas_env("mongodb://unused"):
            cmd, rt = run_submit(status, keep)
        assert text_of(cmd).startswith(f"Medic approved. Recorded: {status}."), text_of(cmd)
        assert len(docs) == 1, (status, docs)
        doc = docs[0]
        assert doc["patient_id"] == PATIENT and doc["thread_id"] == "t2" and doc["status"] == status and doc["summary"] == "s"
        assert {"region", "volume_ml", "confidence", "type", "archived_at"} <= doc.keys() and doc["reading"] == rt.state["reading"]
        assert "map" not in doc and "map" not in doc["reading"]


def test_failing_archive_does_not_break_the_scan():
    async def boom(doc):
        raise RuntimeError("down")

    with atlas_env("mongodb://unused"):
        cmd, _ = run_submit("bleed", boom)  # the background task fails; the tool result is untouched
    assert "Medic approved. Recorded: bleed." in text_of(cmd)


def test_archive_scan_never_raises():
    class Down:
        def insert_one(self, doc):
            raise ConnectionError("no route to mongodb://user:secret@host")

    with atlas_env("mongodb://user:secret@host"), patched(atlas, _scans=lambda: Down()):
        asyncio.run(atlas.archive_scan({"x": 1}))
    with atlas_env("bogus://lucid"):  # the client cannot even be built
        start = time.monotonic()
        asyncio.run(atlas.archive_scan({"x": 1}))
        assert time.monotonic() - start < 5


if __name__ == "__main__":
    tests = [f for name, f in sorted(globals().items()) if name.startswith("test_")]
    for t in tests:
        t()
        print("ok ", t.__name__)
    print(len(tests), "passed")
