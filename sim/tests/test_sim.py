import numpy as np
import pandas as pd
import pytest

import lucid_sim as ls
from lucid_sim import hardware as hw


def run(medium=ls.HUMAN, bleeds=(), plan=None, seed=0):
    return ls.simulate(ls.Subject(medium, bleeds, seed=seed), plan, seed=seed)


def temporal_diff(df):
    return ls.pair_summary(df).set_index("region").loc["temporal", "coil_R_minus_L_db"]


def test_same_seed_same_frames():
    a = run(bleeds=[ls.Bleed("L-temporal")], seed=4)
    b = run(bleeds=[ls.Bleed("L-temporal")], seed=4)
    pd.testing.assert_frame_equal(ls.raw_frames(a), ls.raw_frames(b))


def test_raw_columns_and_ranges():
    df = run(plan=ls.add_random_artifacts(ls.default_plan(), 0.8, seed=1))
    raw = ls.raw_frames(df)
    assert list(raw.columns) == list(hw.COLUMNS)
    assert (np.diff(raw["t_ms"]) == 10).all()
    for col in ("coil", "ir", "ir_amb"):
        assert raw[col].between(0, 32767).all()
    units = ls.to_units(raw)
    # Handling never saturates the IMU, and gravity is about 1 g at rest.
    assert units[["gx_dps", "gy_dps", "gz_dps"]].abs().max().max() < 245
    rest = units.iloc[:50]
    assert np.sqrt((rest[["ax_g", "ay_g", "az_g"]] ** 2).sum(axis=1)).mean() == pytest.approx(1.0, abs=0.05)


def test_serial_round_trip():
    df = run()
    lines = ls.serial_lines(df)
    assert lines[0] == ls.HEADER
    parsed = ls.read_frames(lines + ["garbage,1,2", ""])
    pd.testing.assert_frame_equal(parsed, ls.raw_frames(df).reset_index(drop=True), check_dtype=False)


def test_bleed_side_reads_more_loss():
    for seed in range(3):
        assert temporal_diff(run(bleeds=[ls.Bleed("L-temporal", 30)], seed=seed)) > 0.2
        assert temporal_diff(run(bleeds=[ls.Bleed("R-temporal", 30)], seed=seed)) < -0.2


def test_healthy_pairs_are_close():
    for seed in range(5):
        assert ls.pair_summary(run(seed=seed))["coil_R_minus_L_db"].abs().max() < 0.3


def test_phantom_balloon_is_obvious():
    df = run(ls.SALINE_PHANTOM, [ls.Bleed("R-parietal", 100, "balloon")])
    pairs = ls.pair_summary(df).set_index("region")
    assert pairs.loc["parietal", "coil_R_minus_L_db"] < -1.5
    assert pairs["coil_R_minus_L_db"].idxmin() == "parietal"


def test_liftoff_reduces_loading():
    coil = ls.CoilModel()
    assert coil.dbm(3e6, 0.25, 0.0) < coil.dbm(3e6, 0.25, 2.0) < coil.dbm(3e6, 0.25, 50.0)
    assert coil.dbm(3e6, 0.25, 50.0) == pytest.approx(coil.drive_dbm, abs=0.01)


def test_artifacts_are_labelled_and_not_good():
    plan = ls.default_plan()
    plan[2] = ls.Dwell(plan[2].spot, artifacts=(ls.Artifact("lift", 1.0, 0.5),))
    plan[3] = ls.Dwell(plan[3].spot, contact=0.3)
    df = run(plan=plan)
    lifted = df[df["true_artifact"] == "lift"]
    assert len(lifted) == 50 and not lifted["true_good"].any()
    assert lifted["true_liftoff_mm"].max() > 4
    assert not df[df["true_spot"] == plan[3].spot.id]["true_good"].any()


def test_frequency_steps_during_hold():
    df = run(plan=ls.default_plan(hold_s=3.0, freqs_hz=(2.9e6, 3.0e6, 3.1e6)))
    hold = df[(df["true_phase"] == "hold") & (df["true_dwell"] == 0)]
    assert list(dict.fromkeys(hold["freq_hz"])) == [2900000, 3000000, 3100000]


@pytest.mark.parametrize("name", sorted(ls.DETECTORS))
def test_detector_round_trip(name):
    det = ls.DETECTORS[name]
    dbm = np.linspace(-15, 15, 31)
    for temp_c in (25.0, 32.0):
        assert np.allclose(det.dbm(det.volts(dbm, temp_c), temp_c), dbm, atol=1e-6)


def test_diode_is_square_law_low_and_linear_high():
    det = ls.DETECTORS["schottky"]
    low = det.volts(np.array([-30.0, -20.0]))
    assert low[1] / low[0] == pytest.approx(10, rel=0.15)  # +10 dB of power -> 10x output
    high = det.volts(np.array([20.0, 26.0206]))  # 3.16 V and 6.32 V peak
    assert high[1] - high[0] == pytest.approx(3.16, rel=0.05)  # follows the peak minus a fixed drop


def test_progression_treatment_and_thinners_order():
    from lucid_sim.progression import PRESETS, Conditions, outlook, simulate_growth

    o = outlook(20, "subdural", "L-temporal", lanes=PRESETS + (Conditions("thinners", blood_thinners=True),))
    end = {lane["name"]: lane["end_volume_ml"] for lane in o["lanes"]}
    (untreated, early, late), thinners = (end[c.name] for c in PRESETS), end["thinners"]
    assert early < late <= untreated < thinners
    assert all(lane["volume"]["mean"][0] == pytest.approx(20) for lane in o["lanes"])
    t, v = simulate_growth(40, "epidural", Conditions("surgery", surgery_at_h=3))
    assert (v[:, -1] < 0.2 * v.max(axis=1)).all()  # surgery takes most of it out


def test_lucid_reading_grows_with_volume():
    from lucid_sim.progression import lucid_z

    z = lucid_z([0, 5, 15, 40], "subdural", "R-parietal")
    assert z[0] == 0 and (np.diff(z) > 0).all()
