"""Behaviour checks for lucid.device. Run from agent/: `python tests/test_device.py` (or pytest).

No probe is needed: the streams here are synthetic (lucid.device.reader.SimulatedSource and
hand-built samples). They test the bridge's logic, not the hardware.
"""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lucid.device import N_SPOTS, SPOT_NAMES, calibrate, client  # noqa: E402
from lucid.device.bridge import Bridge  # noqa: E402
from lucid.device.calibrate import Calibration  # noqa: E402
from lucid.device.protocol import Hello, RawSample, parse_line  # noqa: E402
from lucid.device.reader import SimulatedSource, Source  # noqa: E402
from lucid.device.server import serve  # noqa: E402
from lucid.device.spots import Sample, SpotTracker  # noqa: E402

CAL = Calibration(coil_v_ref=0.80, nir_v_ref=0.45, taken_at="2026-11-15T00:00:00+00:00", samples=100)


class FakeSource(Source):
    def __init__(self, connected: bool = True, reason: str = "") -> None:
        self.connected, self.reason, self.port, self.hello = connected, reason, "test", Hello("test", True, True)


def _still(t0: int, n: int, pitch: float, roll: float, coil: float = -38.2, nir: float = 0.612, jitter: float = 0.0):
    """n samples at 50 Hz with the probe held at one pose."""
    for i in range(n):
        wob = jitter * (1 if i % 2 else -1)
        yield Sample(t=t0 + i * 20, coil_db=coil + wob, nir=nir, pitch=pitch, roll=roll)


def _sweep(tracker: SpotTracker, spots: int, t0: int = 0) -> int:
    """Hold still at `spots` different poses, 1.5 s each. Returns the next timestamp."""
    t = t0
    for k in range(spots):
        for s in _still(t, 75, pitch=10.0 * (k % 3), roll=15.0 * k):
            tracker.feed(s)
        t += 75 * 20
    return t


def _with_tmp_calibration(fn):
    """Run fn with calibrate.save writing to a temp file, not agent/data."""
    real = calibrate.save
    with tempfile.TemporaryDirectory() as d:
        calibrate.save = lambda cal, path=Path(d) / "calibration.json": real(cal, path)
        try:
            return fn()
        finally:
            calibrate.save = real


# ---- protocol ---------------------------------------------------------------
def test_parse_line() -> None:
    got = parse_line(b'{"t":1234,"coil_v":0.8123,"nir_v":0.4410,"pitch":4.2,"roll":-1.0}\r\n')
    assert got == RawSample(t=1234, coil_v=0.8123, nir_v=0.4410, pitch=4.2, roll=-1.0)
    hello = parse_line('{"lucid":"probe","fw":"0.1.0","coil_hz":3000000,"ads":true,"imu":false}')
    assert hello == Hello(fw="0.1.0", ads=True, imu=False)


def test_parse_line_rejects_junk() -> None:
    for bad in (b"", b"\xff\xfe", b"hello", b'{"t":1,"coil_v":0.8', b'{"t":1,"coil_v":"x","nir_v":0,"pitch":0,"roll":0}', b'{"t":1,"coil_v":NaN,"nir_v":0,"pitch":0,"roll":0}', b"[1,2,3]", b'{"t":1}'):
        assert parse_line(bad) is None, bad


# ---- calibration ------------------------------------------------------------
def test_reference_constants_match_the_head_model() -> None:
    from lucid.physics import headmodel

    assert calibrate.COIL_HEALTHY_DB == headmodel.COIL_HEALTHY_DB
    assert calibrate.NIR_HEALTHY == headmodel.NIR_HEALTHY


def test_spot_names_match_the_head_model() -> None:
    from lucid.physics import geometry

    assert SPOT_NAMES == geometry.SPOT_NAMES and N_SPOTS == geometry.N_SPOTS


def test_calibration_maps_the_reference_to_healthy() -> None:
    assert abs(CAL.coil_db(0.80) - calibrate.COIL_HEALTHY_DB) < 1e-9
    assert abs(CAL.nir(0.45) - calibrate.NIR_HEALTHY) < 1e-9
    # Half the voltage is 6.02 dB lower; 60% of it is 4.44 dB lower.
    assert abs(CAL.coil_db(0.40) - (calibrate.COIL_HEALTHY_DB - 6.0206)) < 1e-3
    assert abs(CAL.coil_db(0.48) - (calibrate.COIL_HEALTHY_DB - 4.4370)) < 1e-3
    assert abs(CAL.nir(0.225) - calibrate.NIR_HEALTHY / 2) < 1e-9
    assert CAL.coil_db(0.0) < -100  # a dead channel reads very low, not an error


def test_calibration_from_samples_and_round_trip() -> None:
    rows = [RawSample(t=i * 20, coil_v=0.80 + (0.001 if i % 2 else -0.001), nir_v=0.45, pitch=0, roll=0) for i in range(100)]
    cal = calibrate.from_samples(rows)
    assert abs(cal.coil_v_ref - 0.80) < 1e-6 and abs(cal.nir_v_ref - 0.45) < 1e-9 and cal.samples == 100
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "sub" / "calibration.json"
        assert calibrate.load(path) is None
        calibrate.save(cal, path)
        assert calibrate.load(path) == cal
        path.write_text("not json")
        assert calibrate.load(path) is None


def test_calibration_refuses_bad_input() -> None:
    def fails(rows, word: str) -> None:
        try:
            calibrate.from_samples(rows)
        except ValueError as e:
            assert word in str(e), e
        else:
            raise AssertionError("expected ValueError")

    fails([RawSample(0, 0.8, 0.45, 0, 0)] * 3, "Not enough")
    fails([RawSample(0, 0.0, 0.45, 0, 0)] * 50, "coil channel")
    fails([RawSample(0, 0.8, 0.0, 0, 0)] * 50, "light channel")


# ---- spot capture -----------------------------------------------------------
def test_tracker_captures_eight_spots_in_order() -> None:
    t = SpotTracker()
    assert not t.scanning and t.current is None and not t.complete
    t.start()
    assert t.scanning and t.current == 0
    _sweep(t, 8)
    assert t.complete and not t.scanning and t.current is None
    spots = t.spots()
    assert [s["index"] for s in spots] == list(range(8))
    assert [s["name"] for s in spots] == SPOT_NAMES and [s["angle"] for s in spots] == [i * 45 for i in range(8)]
    assert all(s["quality"] == "good" and s["coil_db"] == -38.2 and s["nir"] == 0.612 for s in spots)


def test_holding_still_takes_one_reading() -> None:
    t = SpotTracker()
    t.start()
    for s in _still(0, 500, pitch=5, roll=5):  # ten seconds without moving
        t.feed(s)
    assert sorted(t.readings) == [0] and t.current == 1


def test_no_capture_while_moving() -> None:
    t = SpotTracker()
    t.start()
    for i in range(300):  # tilt keeps changing by 1 degree a sample
        t.feed(Sample(t=i * 20, coil_db=-38.2, nir=0.612, pitch=float(i % 40), roll=0.0))
    assert not t.readings and t.quality() == "bad"


def test_noisy_contact_is_weak() -> None:
    t = SpotTracker()
    t.start()
    for s in _still(0, 75, pitch=0, roll=0, jitter=0.4):  # +/- 0.4 dB sample to sample
        t.feed(s)
    assert t.readings[0]["quality"] == "weak"
    assert abs(t.readings[0]["coil_db"] - (-38.2)) < 0.05  # the mean is still right


def test_rescan_reads_only_the_named_spots() -> None:
    t = SpotTracker()
    t.start()
    end = _sweep(t, 8)
    before = {i: dict(r) for i, r in t.readings.items()}
    t.start([6, 5])
    assert t.scanning and t.current == 5 and sorted(t.readings) == [0, 1, 2, 3, 4, 7]
    for k, coil in enumerate((-40.0, -42.5)):
        for s in _still(end + k * 1500, 75, pitch=30.0 + 12 * k, roll=-20.0, coil=coil):
            t.feed(s)
    assert t.complete
    assert t.readings[5]["coil_db"] == -40.0 and t.readings[6]["coil_db"] == -42.5
    assert all(t.readings[i] == before[i] for i in (0, 1, 2, 3, 4, 7))


def test_tracker_rejects_unknown_spots() -> None:
    t = SpotTracker()
    for bad in ([8], [-1]):
        try:
            t.start(bad)
        except ValueError:
            pass
        else:
            raise AssertionError(bad)


def test_probe_reboot_restarts_the_window() -> None:
    t = SpotTracker()
    t.start()
    for s in _still(50_000, 30, pitch=0, roll=0):
        t.feed(s)
    for s in _still(0, 75, pitch=0, roll=0):  # clock went back to zero
        t.feed(s)
    assert sorted(t.readings) == [0]


# ---- bridge -----------------------------------------------------------------
def _feed_simulated(bridge: Bridge, seconds: float, t0: int = 0) -> int:
    sim = SimulatedSource(bridge.on_sample, seed=3)
    n = int(seconds * 50)
    for r in sim.samples(n, t0):
        bridge.on_sample(r)
    return t0 + n * 20


def test_bridge_needs_a_probe_and_a_calibration() -> None:
    b = Bridge()
    b.source = FakeSource(connected=False, reason="No probe found on USB")
    st = b.status()
    assert not st["connected"] and st["reason"] == "No probe found on USB" and not st["calibrated"]
    for expect, connected in (("No probe", False), ("Calibrate first", True)):
        b.source = FakeSource(connected=connected)
        try:
            b.start_scan()
        except ValueError as e:
            assert expect in str(e), e
        else:
            raise AssertionError("expected ValueError")
    assert "Not calibrated" in b.status()["reason"]


def test_bridge_streams_before_calibration_but_does_not_scan() -> None:
    b = Bridge()
    b.source = FakeSource()
    _feed_simulated(b, 2)
    rows = b.samples()
    assert rows and abs(rows[-1]["coil_db"] - calibrate.COIL_HEALTHY_DB) < 0.2  # charts sit at the healthy level
    assert set(rows[-1]) == {"seq", "t", "coil_db", "nir", "imu", "spot", "quality"} and set(rows[-1]["imu"]) == {"pitch", "roll"}
    assert not b.status()["calibrated"]


def test_bridge_calibrate_then_full_scan() -> None:
    def run() -> None:
        b = Bridge()
        b.source = FakeSource()
        t = _feed_simulated(b, 2)
        cal = b.calibrate()
        assert abs(cal.coil_v_ref - 0.80) < 0.002 and b.status()["calibrated"] and b.status()["reason"] == ""
        assert not b.start_scan()["complete"]
        _feed_simulated(b, 30, t)  # ten still-then-move cycles
        scan = b.scan()
        assert scan["complete"] and len(scan["spots"]) == N_SPOTS
        assert all(abs(s["coil_db"] - calibrate.COIL_HEALTHY_DB) < 0.1 and abs(s["nir"] - calibrate.NIR_HEALTHY) < 0.01 for s in scan["spots"])
        st = b.status()
        assert st["complete"] and st["done"] == list(range(8)) and st["spot"] is None

    _with_tmp_calibration(run)


def test_bridge_samples_since() -> None:
    b = Bridge(calibration=CAL)
    b.source = FakeSource()
    _feed_simulated(b, 1)
    rows = b.samples()
    assert len(rows) == 50 and [r["seq"] for r in rows] == list(range(1, 51))
    assert [r["seq"] for r in b.samples(since=45)] == [46, 47, 48, 49, 50]
    assert b.samples(since=50) == []


def test_bridge_rescan_needs_a_scan() -> None:
    b = Bridge(calibration=CAL)
    b.source = FakeSource()
    try:
        b.start_scan([5])
    except ValueError as e:
        assert "No completed scan" in str(e)
    else:
        raise AssertionError("expected ValueError")


# ---- HTTP server and the agent's client -------------------------------------
def _served(bridge: Bridge):
    server = serve(bridge, port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def test_client_reads_a_finished_scan_over_http() -> None:
    b = Bridge(calibration=CAL)
    b.source = FakeSource()
    server, url = _served(b)
    old = client.URL
    client.URL = url
    try:
        assert client.status()["connected"] and client.status()["calibrated"]
        t = _feed_simulated(b, 1)
        b.start_scan()
        try:
            client.read_scan()
        except client.DeviceError as e:
            assert "0 of 8" in str(e)
        else:
            raise AssertionError("expected DeviceError")
        _feed_simulated(b, 30, t)
        spots = client.read_scan()
        assert len(spots) == 8 and set(spots[0]) == {"index", "name", "angle", "coil_db", "nir", "quality"}
    finally:
        client.URL = old
        server.shutdown()
        server.server_close()


def test_client_rescan_waits_for_the_medic() -> None:
    b = Bridge(calibration=CAL)
    b.source = FakeSource()
    server, url = _served(b)
    old = client.URL
    client.URL = url
    try:
        t = _feed_simulated(b, 1)
        b.start_scan()
        t = _feed_simulated(b, 30, t)
        assert b.scan()["complete"]
        # The medic re-reads the spots a moment after the agent asks.
        threading.Timer(0.3, lambda: _feed_simulated(b, 9, t)).start()
        spots = client.rescan([5, 6], wait_s=5, poll_s=0.1)
        assert len(spots) == 8
        try:
            client.rescan([2], wait_s=0.4, poll_s=0.1)  # nobody re-reads it
        except client.DeviceError as e:
            assert "not finished" in str(e)
        else:
            raise AssertionError("expected DeviceError")
    finally:
        client.URL = old
        server.shutdown()
        server.server_close()


def test_client_says_when_the_bridge_is_down() -> None:
    old = client.URL
    client.URL = "http://127.0.0.1:9"  # nothing listens here
    try:
        client.status()
    except client.DeviceError as e:
        assert "not running" in str(e)
    else:
        raise AssertionError("expected DeviceError")
    finally:
        client.URL = old


def test_http_errors_are_json() -> None:
    import urllib.error
    import urllib.request

    b = Bridge()
    b.source = FakeSource()
    server, url = _served(b)
    try:
        req = urllib.request.Request(url + "/scan/start", data=b"{}", method="POST", headers={"Content-Type": "application/json"})
        try:
            urllib.request.urlopen(req, timeout=2)
        except urllib.error.HTTPError as e:
            assert e.code == 409 and "Calibrate first" in json.loads(e.read())["error"]
        else:
            raise AssertionError("expected 409")
        with urllib.request.urlopen(url + "/samples?since=abc", timeout=2) as r:
            assert json.loads(r.read()) == {"samples": []}
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    for name, fn in tests:
        t0 = time.perf_counter()
        fn()
        print(f"ok  {name}  ({time.perf_counter() - t0:.2f} s)")
    print(f"{len(tests)} passed")
