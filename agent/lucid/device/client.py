"""What the agent's tools use to read the probe: a small client for the device bridge."""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request

from . import N_SPOTS

URL = os.getenv("LUCID_DEVICE_URL", "http://localhost:2025").rstrip("/")
TIMEOUT_S = 3.0
RESCAN_WAIT_S = float(os.getenv("LUCID_RESCAN_WAIT_S", "90"))


class DeviceError(RuntimeError):
    """The bridge is not running, or it refused (no probe, not calibrated, scan not finished)."""


def _call(path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, method="POST" if body is not None else "GET", headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get("error", "")
        except (ValueError, OSError):
            msg = ""
        raise DeviceError(msg or f"The device bridge answered {e.code}.") from e
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise DeviceError("The device bridge is not running. Start it with `python -m lucid.device` in /agent.") from e


def status() -> dict:
    return _call("/status")


def read_scan() -> list[dict]:
    """The 8 spot readings of the scan the medic just finished on the probe."""
    got = _call("/scan")
    if not got.get("complete"):
        done = len(got.get("spots", []))
        raise DeviceError(f"The probe has read {done} of {N_SPOTS} spots. Finish the scan on the dashboard first.")
    return got["spots"]


def rescan(spots: list[int], wait_s: float = RESCAN_WAIT_S, poll_s: float = 0.5) -> list[dict]:
    """Ask for those spots again and wait until the medic has re-read them. Returns all 8 spots."""
    _call("/scan/start", {"spots": list(spots)})
    deadline = time.monotonic() + wait_s
    while time.monotonic() < deadline:
        got = _call("/scan")
        if got.get("complete"):
            return got["spots"]
        time.sleep(poll_s)
    raise DeviceError(f"The re-scan of spots {list(spots)} was not finished within {int(wait_s)} s.")
