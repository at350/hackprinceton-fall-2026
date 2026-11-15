"""read_scan and request_rescan in Device mode: the agent's tools against a (patched) device bridge.

Run from agent/:  .venv/bin/python tests/test_device_tools.py   (or pytest). No probe, no network, no model calls.
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from langgraph.store.memory import InMemoryStore  # noqa: E402

from lucid import physics, tools  # noqa: E402
from lucid.device import SCAN_ID, client  # noqa: E402


@contextmanager
def patched(obj, **attrs):
    old = {k: getattr(obj, k) for k in attrs}
    for k, v in attrs.items():
        setattr(obj, k, v)
    try:
        yield
    finally:
        for k, v in old.items():
            setattr(obj, k, v)


def _spots(weak: tuple[int, ...] = (), coil: dict[int, float] | None = None) -> list[dict]:
    """Spot readings in the bridge's shape: healthy everywhere unless `coil` says otherwise."""
    healthy = physics.null_reading()
    return [
        {"index": i, "name": physics.SPOT_NAMES[i], "angle": i * 45, "coil_db": (coil or {}).get(i, healthy["coil_db"][i]), "nir": healthy["nir"][i], "quality": "weak" if i in weak else "good"}
        for i in range(8)
    ]


def _runtime(state: dict):
    events: list = []
    return SimpleNamespace(state=state, config={"configurable": {"thread_id": "t1"}}, tool_call_id="c1", store=InMemoryStore(), stream_writer=events.append), events


def _run(coro_fn, files: dict):
    async def no_baseline(_path):
        return None

    async def write(path, content):
        files[path] = content

    async def delete(_path):
        return None

    async def go():
        with patched(tools, _read_json=no_baseline), patched(tools.backend, awrite=write, adelete=delete):
            return await coro_fn()

    return asyncio.run(go())


def test_read_scan_takes_the_spots_from_the_bridge() -> None:
    rt, events = _runtime({"scan_id": SCAN_ID, "patient_id": "P-0042"})
    files: dict = {}
    spots = _spots(coil={6: -42.6})
    with patched(client, read_scan=lambda: spots):
        cmd = _run(lambda: tools.read_scan.coroutine(runtime=rt), files)
    reading = cmd.update["reading"]
    assert reading["case"] == SCAN_ID and reading["patient_id"] == "P-0042" and reading["taken_at"]
    assert [s["coil_db"] for s in reading["spots"]] == [s["coil_db"] for s in spots]
    doc = json.loads(files[tools.SCAN_FILE])
    assert doc["spots"][6]["coil_db"] == -42.6 and doc["spots"][6]["coil_change_db"] == round(-42.6 - physics.null_reading()["coil_db"][6], 2)
    assert any(e.get("type") == "scan" for e in events)
    assert "L temporal" in cmd.update["messages"][0].content


def test_read_scan_reports_an_unfinished_or_missing_device() -> None:
    def unfinished():
        raise client.DeviceError("The probe has read 3 of 8 spots. Finish the scan on the dashboard first.")

    def down():
        raise client.DeviceError("The device bridge is not running. Start it with `python -m lucid.device` in /agent.")

    for fail, word in ((unfinished, "3 of 8"), (down, "not running")):
        rt, _ = _runtime({"scan_id": SCAN_ID})
        files: dict = {}
        with patched(client, read_scan=fail):
            cmd = _run(lambda: tools.read_scan.coroutine(runtime=rt), files)
        text = cmd.update["messages"][0].content
        assert text.startswith("Can't read the device") and word in text
        assert "reading" not in cmd.update and not files  # nothing is published


def test_unknown_scan_lists_the_device_too() -> None:
    rt, _ = _runtime({"scan_id": "nope"})
    cmd = _run(lambda: tools.read_scan.coroutine(runtime=rt), {})
    text = cmd.update["messages"][0].content
    assert "Unknown scan" in text and SCAN_ID in text and "temporal_bleed" in text


def test_mock_scans_are_unchanged() -> None:
    rt, _ = _runtime({"scan_id": "clear", "patient_id": "P-1"})
    with patched(client, read_scan=lambda: (_ for _ in ()).throw(AssertionError("the bridge must not be asked"))):
        cmd = _run(lambda: tools.read_scan.coroutine(runtime=rt), {})
    assert cmd.update["reading"]["case"] == "clear"


def test_rescan_asks_the_bridge_for_the_weak_spots() -> None:
    first = {"case": SCAN_ID, "patient_id": "P-0042", "taken_at": "2026-11-15T09:00:00+00:00", "later_scan": False, "transport": None, "medic_notes": None, "spots": _spots(weak=(5, 6))}
    asked: list = []

    def rescan(spots):
        asked.append(list(spots))
        return _spots(coil={5: -39.0, 6: -42.6})

    rt, _ = _runtime({"scan_id": SCAN_ID, "reading": first})
    files: dict = {}
    with patched(client, rescan=rescan):
        cmd = _run(lambda: tools.request_rescan.coroutine(spots=[5, 6], reason="Contact was weak.", runtime=rt), files)
    assert asked == [[5, 6]]
    reading = cmd.update["reading"]
    assert reading["case"] == SCAN_ID and reading["spots"][6]["coil_db"] == -42.6 and reading["spots"][6]["quality"] == "good"
    assert cmd.update["rescans"] == 1 and "Medic re-scanned" in cmd.update["messages"][0].content


def test_rescan_that_times_out_keeps_the_first_readings() -> None:
    first = {"case": SCAN_ID, "patient_id": "P-0042", "taken_at": "2026-11-15T09:00:00+00:00", "later_scan": False, "spots": _spots(weak=(5,))}

    def rescan(_spots):
        raise client.DeviceError("The re-scan of spots [5] was not finished within 90 s.")

    rt, _ = _runtime({"scan_id": SCAN_ID, "reading": first})
    files: dict = {}
    with patched(client, rescan=rescan):
        cmd = _run(lambda: tools.request_rescan.coroutine(spots=[5], reason="Contact was weak.", runtime=rt), files)
    text = cmd.update["messages"][0].content
    assert "did not complete" in text and "first readings stand" in text
    assert "reading" not in cmd.update and "rescans" not in cmd.update and not files


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    for name, fn in tests:
        t0 = time.perf_counter()
        fn()
        print(f"ok  {name}  ({time.perf_counter() - t0:.2f} s)")
    print(f"{len(tests)} passed")
