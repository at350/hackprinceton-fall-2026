"""The case archive: one document per approved scan in MongoDB Atlas (`lucid.scans`).

Optional. With MONGODB_ATLAS_URL unset nothing is archived. A failed write is logged and dropped,
never raised: the archive must not slow down or break a scan. The URL holds credentials, so it is never logged.
"""

import asyncio
import logging
import os
import threading
from pathlib import Path

log = logging.getLogger("lucid.atlas")
_client = None
_lock = threading.Lock()


def enabled() -> bool:
    """True when the URL is set. Like photon.enabled, reads ../.env when it is missing: a hot reload does not."""
    if not os.getenv("MONGODB_ATLAS_URL"):
        _load_env()
    return bool(os.getenv("MONGODB_ATLAS_URL"))


def _scans():
    global _client
    with _lock:  # the client is built once; building it resolves the SRV record, so it runs off the event loop too
        if _client is None:
            from pymongo import MongoClient

            _client = MongoClient(os.environ["MONGODB_ATLAS_URL"], serverSelectionTimeoutMS=2500, connectTimeoutMS=2500, socketTimeoutMS=5000, appname="lucid")
    return _client["lucid"]["scans"]


async def archive_scan(doc: dict) -> None:
    """Insert one case record. Never raises."""
    if not enabled():
        return
    try:
        await asyncio.to_thread(lambda: _scans().insert_one(dict(doc)))  # a copy: insert_one adds _id
    except Exception as e:  # noqa: BLE001 - the archive is a side record; the scan goes on without it
        text = str(e).replace(os.environ.get("MONGODB_ATLAS_URL") or "\0", "<url>")
        log.warning("Scan not archived to Atlas: %s %s", type(e).__name__, text.splitlines()[0][:200] if text else "")


def _load_env() -> None:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
