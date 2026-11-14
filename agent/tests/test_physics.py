"""Behaviour checks for lucid.physics. Run from agent/: `python tests/test_physics.py` (or pytest)."""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402

import lucid.physics as P  # noqa: E402
from lucid.physics import scans  # noqa: E402


def _scores(scan: dict) -> tuple[dict[str, float], float]:
    s = {h["id"]: P.fit(P.lookup(h["id"]), scan) for h in P.all_hypotheses()}
    return s, P.fit(P.null_reading(), scan)


def _best(scores: dict[str, float], prefix: str = "") -> tuple[str, float]:
    k = max((k for k in scores if k.startswith(prefix)), key=scores.get)
    return k, scores[k]


def test_ids_and_grid() -> None:
    hs = P.all_hypotheses()
    assert len(hs) == 192 and len({h["id"] for h in hs}) == 192
    assert P.hypothesis_id("epidural", "L temporal", 20) == "epi-LT-20"
    assert P.hypothesis_id("subdural", "R frontal", 5) == "sub-RF-05"
    assert P.parse_hypothesis_id("iph-LO-40") == {
        "id": "iph-LO-40", "type": "intraparenchymal", "region": "L occipital", "volume_ml": 40, "agent": "occipital",
    }
    for h in hs:
        assert P.hypothesis_id(h["type"], h["region"], h["volume_ml"]) == h["id"] and h["agent"] in P.LOBES
    assert len(P.SPOT_NAMES) == 8 and len(P.REGION_ANGLE) == 8


def test_forward_calibration_and_table() -> None:
    null = P.null_reading()
    assert null["coil_db"] == [-38.2] * 8 and null["nir"] == [0.612] * 8
    ref = P.forward("epidural", "L temporal", 22)
    assert abs(ref["coil_db"][6] - (-38.2 - 4.4)) < 1e-6 and abs(ref["nir"][6] - (0.612 - 0.07)) < 1e-6
    # Live solve agrees with the precomputed table (4 dp) and is fast.
    for hid in ("epi-LT-20", "sub-RF-05", "iph-LO-40"):
        h = P.parse_hypothesis_id(hid)
        t0 = time.perf_counter()
        live = P.forward(h["type"], h["region"], h["volume_ml"])
        assert time.perf_counter() - t0 < 0.5
        tab = P.lookup(hid)
        assert np.allclose(live["coil_db"], tab["coil_db"], atol=1e-3), hid
        assert np.allclose(live["nir"], tab["nir"], atol=1e-4), hid
    # A bleed lowers both signals, most under its own spot, and more with volume.
    drops = [-38.2 - P.lookup(f"epi-LT-{v:02d}")["coil_db"][6] for v in P.VOLUMES]
    assert all(b > a > 0 for a, b in zip(drops, drops[1:]))
    # Deep bleeds barely move NIR; superficial ones do. This is what separates the types.
    nir_drop = {t: 0.612 - P.lookup(f"{t}-LT-20")["nir"][6] for t in ("epi", "sub", "iph")}
    assert nir_drop["iph"] < 0.35 * nir_drop["sub"] < 0.35 * nir_drop["epi"]


def test_fit_basics() -> None:
    scan = P.mock_scan("temporal_bleed")
    sim = P.lookup("epi-LT-20")
    exact = {"spots": [{"index": i, "coil_db": c, "nir": n, "quality": "good"} for i, (c, n) in enumerate(zip(sim["coil_db"], sim["nir"]))]}
    assert P.fit(sim, exact) == 1.0
    # Monotone in the residual.
    worse = [P.fit({"coil_db": [c - d for c in sim["coil_db"]], "nir": sim["nir"]}, exact) for d in (0.1, 0.3, 1.0, 3.0)]
    assert all(a > b for a, b in zip([1.0] + worse, worse))
    # Baseline removes a whole-head offset.
    shifted = {**scan, "spots": [{**s, "coil_db": s["coil_db"] + 0.8, "nir": s["nir"] + 0.01} for s in scan["spots"]]}
    base = {"spots": [{"index": i, "coil_db": -38.2 + 0.8, "nir": 0.612 + 0.01, "quality": "good"} for i in range(8)]}
    assert P.fit(sim, shifted) < 0.6 < P.fit(sim, shifted, baseline=base)
    assert abs(P.fit(sim, shifted, baseline=base) - P.fit(sim, scan)) < 0.02


def test_temporal_bleed() -> None:
    s, null = _scores(P.mock_scan("temporal_bleed"))
    best_id, best = _best(s)
    assert best_id in ("epi-LT-20", "epi-LT-25") and best >= 0.88, (best_id, best)
    other = max(v for k, v in s.items() if k[4:6] != "LT")
    assert other <= best - 0.10, other
    sub, iph = _best(s, "sub-LT")[1], _best(s, "iph-LT")[1]
    assert 0.75 <= sub <= 0.85 and sub < best, sub
    assert iph < sub, (iph, sub)
    assert max(v for k, v in s.items() if k[4] == "R") < 0.25
    assert null < 0.25, null


def test_temporal_rescan() -> None:
    s, _ = _scores(P.mock_scan("temporal_bleed", rescan=True))
    best_id, best = _best(s)
    assert best_id in ("epi-LT-25", "epi-LT-30") and best >= 0.85, (best_id, best)


def test_clear() -> None:
    for rescan in (False, True):
        s, null = _scores(P.mock_scan("clear", rescan=rescan))
        assert null >= 0.90, null
        assert max(s.values()) <= null - 0.10, _best(s)


def test_uncertain() -> None:
    scan = P.mock_scan("uncertain")
    assert [sp["quality"] for sp in scan["spots"]] == ["good"] * 5 + ["weak", "weak", "good"]
    s, null = _scores(scan)
    ranked = sorted(s.items(), key=lambda kv: -kv[1])
    (best_id, best) = ranked[0]
    assert 0.45 <= best <= 0.78, (best_id, best)
    assert null < 0.8, null
    # The runner-up from a different region is within 0.05: the read is ambiguous.
    rival = next(v for k, v in ranked if k[4:6] != best_id[4:6])
    assert best - rival <= 0.05, (best, rival)


def test_not_knife_edge() -> None:
    """Cases 1-2 hold for other noise seeds too, not just the shipped ones."""
    saved = {k: dict(v) for k, v in scans._CASES.items()}
    try:
        for seed in range(100, 108):
            for key in scans._CASES:
                scans._CASES[key]["seed"] = seed
            s, null = _scores(P.mock_scan("temporal_bleed"))
            best_id, best = _best(s)
            assert best_id in ("epi-LT-20", "epi-LT-25") and best >= 0.88 and null < 0.25, (seed, best_id, best)
            assert max(v for k, v in s.items() if k[4:6] != "LT") <= best - 0.10
            assert 0.70 <= _best(s, "sub-LT")[1] <= 0.88 and _best(s, "iph-LT")[1] < _best(s, "sub-LT")[1]
            s, _ = _scores(P.mock_scan("temporal_bleed", rescan=True))
            assert _best(s)[0] in ("epi-LT-25", "epi-LT-30") and _best(s)[1] >= 0.85, (seed, _best(s))
            s, null = _scores(P.mock_scan("clear"))
            assert null >= 0.90 and max(s.values()) <= null - 0.10, (seed, null, _best(s))
            s, null = _scores(P.mock_scan("uncertain"))
            assert 0.45 <= _best(s)[1] <= 0.78 and null < 0.8, (seed, _best(s), null)
    finally:
        scans._CASES.update(saved)


def test_mock_scan_shape() -> None:
    for case in P.MOCK_CASES:
        a, b = P.mock_scan(case), P.mock_scan(case)
        assert a == b and a["case"] == case and a["taken_at"] is None and len(a["spots"]) == 8
        for i, sp in enumerate(a["spots"]):
            assert sp["index"] == i and sp["name"] == P.SPOT_NAMES[i] and sp["angle"] == i * 45
            assert set(sp) == {"index", "name", "angle", "coil_db", "nir", "quality"}
    assert P.mock_scan("temporal_bleed") != P.mock_scan("temporal_bleed", rescan=True)


def test_maps() -> None:
    m = np.array(P.hypothesis_map("epidural", "L temporal", 20))
    assert m.shape == (32, 32) and m.min() == 0.0 and m.max() <= 1.0
    assert m[0, 0] == 0.0 and m[16, 16] == 0.06  # outside the head / plain brain
    row, col = np.unravel_index(m.argmax(), m.shape)
    assert col < 8 and 12 <= row <= 19  # bleed on screen left (patient's left), mid height

    scan = P.mock_scan("temporal_bleed")
    lm = np.array(P.likelihood_map(scan))
    assert lm.shape == (64, 64) and lm[0, 0] == 0.0 and 0.0 <= lm.min() and lm.max() <= 1.0
    row, col = np.unravel_index(lm.argmax(), lm.shape)
    assert col < 16 and 24 <= row <= 40 and lm.max() > 0.8
    inside = lm[lm > 0]
    assert 0.07 <= inside.min() and np.median(inside) <= 0.15  # background band
    peaks = P.spot_peaks(scan)
    assert len(peaks) == 8 and int(np.argmax(peaks)) == 6 and peaks[6] > 0.8 and max(peaks[1:4]) < 0.25
    assert abs(max(peaks) - lm.max()) < 0.03  # consistent with the map

    clear = P.mock_scan("clear")
    assert np.array(P.likelihood_map(clear)).max() < 0.25 and max(P.spot_peaks(clear)) < 0.25


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    for name, fn in tests:
        t0 = time.perf_counter()
        fn()
        print(f"ok  {name}  ({time.perf_counter() - t0:.2f} s)")
    print(f"{len(tests)} passed")
