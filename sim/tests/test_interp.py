import numpy as np
import pytest

import lucid_interp as li
import lucid_sim as ls
from lucid_interp.live import LiveScan
from lucid_interp.truth import compare_to_truth


def scan(medium=ls.HUMAN, bleeds=(), artifacts=0.0, seed=0, **plan_kw):
    plan = ls.default_plan(**plan_kw)
    if artifacts:
        plan = ls.add_random_artifacts(plan, artifacts, seed=seed)
    session = ls.simulate(ls.Subject(medium, bleeds, seed=seed), plan, seed=seed)
    return session, li.interpret(ls.raw_frames(session))


def test_decompose_rebuilds_signal_and_finds_tones():
    fs = 100
    t = np.arange(400) / fs
    x = 0.5 + 0.01 * t + 0.01 * np.sin(2 * np.pi * 1.2 * t) + 0.005 * np.sin(2 * np.pi * 20 * t)
    d = li.decompose(x, fs)
    assert np.allclose(d.reconstruct(), x)
    assert d.slope_per_s == pytest.approx(0.01, abs=1e-3)
    assert d.peak_hz["pulse"] == pytest.approx(1.2, abs=0.05)
    assert d.peak_hz["flicker"] == pytest.approx(20.0, abs=0.1)
    assert d.rms["pulse"] == pytest.approx(0.01 / np.sqrt(2), rel=0.1)


def test_flicker_alias():
    assert li.flicker_alias_hz(100, 60) == pytest.approx(20)
    assert li.flicker_alias_hz(100, 50) == pytest.approx(0)
    assert "flicker" not in [b.name for b in li.default_bands(100, 50)]


def test_coil_inversion_round_trip():
    coil = ls.CoilModel()
    for sigma in (0.1, 0.3, 1.2):
        loss = coil.dbm(3e6, sigma, 0.0) - coil.dbm(3e6, 0.0, 0.0)
        s, slope = li.invert_coil(loss, 3e6, coil)
        assert s == pytest.approx(sigma, rel=1e-6)
        assert slope < 0


def test_finds_every_spot_and_recovers_layers():
    session, interp = scan(bleeds=[ls.Bleed("L-temporal")], artifacts=0.3, seed=2)
    assert [c.spot for c in interp.contacts] == [s.id for s in ls.DEFAULT_SPOTS]
    truth = compare_to_truth(interp, session)
    assert (truth["spot"] == truth["true_spot"]).all()
    ok = truth.dropna(subset=["sigma"])
    assert (ok["sigma_err_pct"].abs() < 5).all()
    assert (np.abs(ok["gap_mm"] - ok["true_gap_mm"]) < 0.3).all()


def test_rejects_handling_artifacts():
    plan = ls.default_plan()
    plan[4] = ls.Dwell(plan[4].spot, artifacts=(ls.Artifact("lift", 1.0, 0.5),))
    plan[6] = ls.Dwell(plan[6].spot, artifacts=(ls.Artifact("wobble", 1.0, 0.6),))
    session = ls.simulate(ls.Subject(ls.HUMAN, seed=0), plan, seed=0)
    interp = li.interpret(ls.raw_frames(session))
    truth = compare_to_truth(interp, session)
    assert truth["kept_but_bad"].sum() <= 3
    assert interp.contacts[4].rejected["coil jump"] > 0
    assert interp.contacts[6].rejected["motion"] > 0


@pytest.mark.parametrize("seed", range(4))
def test_healthy_is_clear(seed):
    assert scan(seed=seed, artifacts=0.3)[1].flag["status"] == "clear"


@pytest.mark.parametrize("spot", ["L-temporal", "R-temporal"])
def test_bleed_flagged_on_its_side(spot):
    # A head's natural asymmetry can hide a 30 ml bleed now and then, so check the hit rate.
    flags = [scan(bleeds=[ls.Bleed(spot, 30)], seed=seed)[1].flag for seed in range(6)]
    hits = [f for f in flags if f["status"] == "asymmetry"]
    assert len(hits) >= 5
    # A subdural spreads, so the neighbouring spot can come out on top.
    assert all(f["side"] == spot[0] and f["regions"][0] in ("temporal", "frontotemporal") for f in hits)
    assert all(f["status"] in ("asymmetry", "clear") for f in flags)


def test_phantom_balloon_located():
    flag = scan(ls.SALINE_PHANTOM, [ls.Bleed("R-parietal", 100, "balloon")])[1].flag
    assert (flag["status"], flag["side"], flag["regions"][0]) == ("asymmetry", "R", "parietal")


def test_multi_frequency_rows_and_heart_rate():
    _, interp = scan(freqs_hz=(2.95e6, 3.0e6, 3.05e6), hold_s=4.5)
    assert interp.layers.groupby("spot").size().eq(3).all()
    assert interp.flag["heart_rate_bpm"] == pytest.approx(75, abs=6)


def test_dark_room_falls_back_to_assumed_gap():
    session = ls.simulate(ls.Subject(ls.HUMAN, seed=0), seed=0, optical=ls.OpticalModel(room_v=0.0))
    interp = li.interpret(ls.raw_frames(session))
    assert interp.spots["note"].str.contains("dark room").all()
    assert interp.flag["status"] == "clear"


@pytest.mark.parametrize("detector, drive", [("ad8307", 0.0), ("schottky", 0.0), ("1n4148", 10.0)])
def test_detectors_that_work(detector, drive):
    det, coil = ls.DETECTORS[detector], ls.CoilModel(drive_dbm=drive)
    session = ls.simulate(ls.Subject(ls.HUMAN, [ls.Bleed("L-temporal")], seed=0), seed=0, detector=det, coil=coil)
    interp = li.interpret(ls.raw_frames(session), calibration=li.Calibration(detector=det, coil=coil))
    assert (interp.flag["status"], interp.flag["side"]) == ("asymmetry", "L")
    assert compare_to_truth(interp, session)["sigma_err_pct"].abs().max() < 5


def test_weak_detector_says_so_instead_of_guessing():
    det, coil = ls.DETECTORS["1n4148"], ls.CoilModel(drive_dbm=0.0)
    session = ls.simulate(ls.Subject(ls.HUMAN, [ls.Bleed("L-temporal")], seed=0), seed=0, detector=det, coil=coil)
    flag = li.interpret(ls.raw_frames(session), calibration=li.Calibration(detector=det, coil=coil)).flag
    assert flag["status"] == "incomplete"
    assert "too weak" in flag["text"]


def test_wrong_diode_assumption_still_finds_side():
    session = ls.simulate(ls.Subject(ls.HUMAN, [ls.Bleed("R-temporal")], seed=0), seed=0)
    guess = ls.DiodeDetector(name="guess", saturation_a=3e-7, ideality=1.2)
    flag = li.interpret(ls.raw_frames(session), calibration=li.Calibration(detector=guess)).flag
    assert (flag["status"], flag["side"]) == ("asymmetry", "R")


@pytest.mark.parametrize("seed", range(3))
def test_locate_healthy_finds_nothing(seed):
    loc = li.locate(scan(seed=seed)[1])
    assert loc.summary["status"] == "none"


def test_locate_subdural_side_region_and_edge():
    bleed = ls.Bleed("L-temporal")
    session, interp = scan(bleeds=[bleed], seed=1)
    loc = li.locate(interp)
    s = loc.summary
    assert (s["status"], s["side"], s["region"]) == ("localized", "L", "temporal")
    centre, depth, _, _ = bleed.geometry(ls.HUMAN)
    near_edge = centre * (90.0 - depth)  # head radius
    assert np.linalg.norm(np.array(s["centroid_mm"]) - near_edge) < 25
    assert loc.blood[loc.voxels[:, 0] > 0].max() < 0.05  # no blood painted on the healthy side


def test_locate_phantom_balloon_and_render(tmp_path):
    loc = li.locate(scan(ls.SALINE_PHANTOM, [ls.Bleed("R-parietal", 100, "balloon")])[1], li.PRIORS["phantom"])
    assert (loc.summary["side"], loc.summary["region"]) == ("R", "parietal")
    assert loc.summary["p_right"] > 0.999
    assert loc.blood.max() > 0.5
    records = loc.cloud_records()
    assert records and set(records[0]) == {"x", "y", "z", "blood", "edge"}
    from lucid_interp.render import render_head

    render_head(loc, tmp_path / "head.png")
    assert (tmp_path / "head.png").stat().st_size > 10_000


def live_run(session, scan, follow_after=None):
    updates = []
    for line in ls.serial_lines(session):
        u = scan.feed(line)
        if u is not None:
            updates.append(u)
            if follow_after and u.done and u.done[-1] == follow_after and scan.plan.count(ls.Spot.parse(follow_after)) == 1:
                scan.follow(follow_after)  # the operator rescans it, as the app would report
    return updates, scan.finish()


def test_live_updates_each_spot_and_predicts_the_next():
    session = ls.simulate(ls.Subject(ls.HUMAN, [ls.Bleed("L-temporal")], seed=1), seed=1)
    updates, final = live_run(session, LiveScan(n_sims=300))
    assert len(updates) >= 8 and final.final
    assert [len(u.done) for u in updates] == sorted(len(u.done) for u in updates)
    assert updates[0].p_bleed == pytest.approx(0.1, abs=0.02)  # nothing known yet
    assert final.p_bleed > 0.9 and final.location["side"] == "L"
    first = updates[0]
    assert first.next_spot == "R-frontal" and len(first.predictions) == 9
    row = first.predictions.set_index("spot").loc["R-frontal"]
    assert row["loss_db_lo"] < row["loss_db_hi"] < 0  # tissue always lowers the coil reading


@pytest.mark.parametrize("seed", range(2))
def test_live_healthy_stays_calm(seed):
    session = ls.simulate(ls.Subject(ls.HUMAN, seed=seed), seed=seed)
    updates, final = live_run(session, LiveScan(n_sims=300))
    assert final.p_bleed < 0.15
    assert not any(u.surprises for u in updates)


def test_live_rescan_is_pooled():
    plan = ls.default_plan()
    plan.insert(6, ls.Dwell(plan[5].spot))  # R-temporal twice
    session = ls.simulate(ls.Subject(ls.HUMAN, [ls.Bleed("L-temporal")], seed=3), plan, seed=3)
    scan = LiveScan(n_sims=300)
    _, final = live_run(session, scan, follow_after="R-temporal")
    assert [c.spot for c in scan.interp.contacts].count("R-temporal") == 2
    assert not any(c.spot.startswith("extra") for c in scan.interp.contacts)
    assert scan.interp.flag["side"] == "L"
