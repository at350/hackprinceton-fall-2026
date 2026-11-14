"""Scan plans and the session simulator: turns a subject and a plan into raw frames plus ground truth."""
from __future__ import annotations

from dataclasses import dataclass, replace

import numpy as np
import pandas as pd
from scipy.spatial.transform import Rotation

from . import hardware as hw
from .anatomy import DEFAULT_SPOTS, HEAD_RADIUS_MM, Spot, Subject
from .channels import CoilModel, ImuModel, OpticalModel, band_noise

ARTIFACT_KINDS = ("slip", "wobble", "lift", "shake")

PLACE_S = 0.4  # hover to contact
LIFT_S = 0.3  # contact back to hover
LEAD_OUT_S = 0.5
SETTLE_S = 0.3  # readings this soon after contact are not counted as good
HAIR_COMPRESSION = 0.7  # share of hair thickness left under the pressed probe
POOR_CONTACT_GAP_MM = 3.0  # gap at contact = 0
IMU_OFFSET_MM = 80.0  # IMU sits this far behind the coil face, in the grip
COIL_RADIUS_MM = 35.0


@dataclass(frozen=True)
class Artifact:
    """Something going wrong during a hold. Times are from the start of the hold."""

    kind: str  # "slip" | "wobble" | "lift" | "shake"
    start_s: float
    duration_s: float = 0.5
    strength: float = 1.0

    def __post_init__(self):
        if self.kind not in ARTIFACT_KINDS:
            raise ValueError(f"unknown artifact {self.kind!r}, expected one of {ARTIFACT_KINDS}")


@dataclass(frozen=True)
class Dwell:
    """Holding the probe on one spot."""

    spot: Spot | str
    hold_s: float = 3.0
    freqs_hz: tuple[float, ...] = (3.0e6,)  # stepped through evenly during the hold
    contact: float = 1.0  # 1 = pressed flat, 0 = barely touching
    artifacts: tuple[Artifact, ...] = ()

    def __post_init__(self):
        object.__setattr__(self, "spot", Spot.parse(self.spot))
        object.__setattr__(self, "freqs_hz", tuple(float(f) for f in self.freqs_hz))
        object.__setattr__(self, "artifacts", tuple(self.artifacts))


def default_plan(spots=DEFAULT_SPOTS, hold_s: float = 3.0, freqs_hz=(3.0e6,)) -> list[Dwell]:
    return [Dwell(spot, hold_s=hold_s, freqs_hz=tuple(freqs_hz)) for spot in spots]


def add_random_artifacts(plan: list[Dwell], rate: float = 0.3, seed: int | None = None) -> list[Dwell]:
    """Sprinkle handling problems over a plan, for testing signal QA."""
    rng = np.random.default_rng(seed)
    out = []
    for dwell in plan:
        artifacts = list(dwell.artifacts)
        contact = dwell.contact
        if rng.random() < rate:
            duration = rng.uniform(0.3, 0.8)
            start = rng.uniform(0.2, max(0.25, dwell.hold_s - duration - 0.1))
            artifacts.append(Artifact(str(rng.choice(ARTIFACT_KINDS)), start, duration, rng.uniform(0.5, 1.5)))
        if rng.random() < rate / 2:
            contact = rng.uniform(0.3, 0.7)
        out.append(replace(dwell, artifacts=tuple(artifacts), contact=contact))
    return out


def _min_jerk(tau):
    tau = np.clip(tau, 0.0, 1.0)
    return tau**3 * (10 - 15 * tau + 6 * tau**2)


def _slerp(a: np.ndarray, b: np.ndarray, s: np.ndarray) -> np.ndarray:
    dot = np.clip(np.einsum("ij,ij->i", a, b), -1.0, 1.0)
    omega = np.arccos(dot)[:, None]
    small = omega[:, 0] < 1e-6
    sin_omega = np.where(small[:, None], 1.0, np.sin(omega))
    out = (np.sin((1 - s[:, None]) * omega) * a + np.sin(s[:, None] * omega) * b) / sin_omega
    out[small] = a[small] + s[small, None] * (b[small] - a[small])
    return out / np.linalg.norm(out, axis=1, keepdims=True)


def _probe_axes(dirs: np.ndarray, roll: np.ndarray, tilt: np.ndarray) -> np.ndarray:
    """Device axes in the head frame, as columns (N, 3, 3). z points out of the coil face into the head."""
    z = -dirs
    # Carry the x axis along the path (parallel transport) so it never flips, even over the crown.
    x0 = np.empty_like(dirs)
    prev = np.cross([0.0, 0.0, 1.0], dirs[0])
    if np.linalg.norm(prev) < 1e-6:
        prev = np.array([1.0, 0.0, 0.0])
    for i, d in enumerate(dirs):
        prev = prev - (prev @ d) * d
        prev /= np.linalg.norm(prev)
        x0[i] = prev
    y0 = np.cross(z, x0)
    x = np.cos(roll)[:, None] * x0 + np.sin(roll)[:, None] * y0
    y = np.cross(z, x)
    # Rocking the probe tilts it about its own x axis.
    y_t = np.cos(tilt)[:, None] * y + np.sin(tilt)[:, None] * z
    z_t = -np.sin(tilt)[:, None] * y + np.cos(tilt)[:, None] * z
    return np.stack([x, y_t, z_t], axis=2)


def _ou(n: int, dt: float, sd: float, tau_s: float, rng: np.random.Generator) -> np.ndarray:
    a = np.exp(-dt / tau_s)
    noise = rng.normal(0, sd * np.sqrt(1 - a**2), n)
    out = np.empty(n)
    out[0] = rng.normal(0, sd)
    for i in range(1, n):
        out[i] = a * out[i - 1] + noise[i]
    return out


def simulate(subject: Subject, plan: list[Dwell] | None = None, *, sample_rate: float = hw.SAMPLE_RATE_HZ,
             transit_s: float = 1.5, lead_in_s: float = 1.0, hover_mm: float = 40.0, posture: str | None = None,
             seed: int | None = 0, coil: CoilModel = CoilModel(), optical: OpticalModel = OpticalModel(),
             imu: ImuModel = ImuModel(), detector=hw.DEFAULT_DETECTOR, warmup_c: float = 4.0,
             warmup_s: float = 120.0) -> pd.DataFrame:
    """Simulate one scan session.

    Returns one row per frame: the raw columns in hardware.COLUMNS (exactly what the
    Arduino sends) followed by ground-truth columns prefixed "true_".
    """
    plan = [d if isinstance(d, Dwell) else Dwell(d) for d in (plan or default_plan())]
    posture = posture or subject.medium.posture
    rng = np.random.default_rng(seed)
    R = HEAD_RADIUS_MM
    hover_r = R + hover_mm

    # Keyframes for the probe pose (direction from head centre, radius, roll) and the segments between them.
    rest_dir = np.array([0.0, 1.0, 0.0])
    keys = [(0.0, rest_dir, R + 120.0, 0.0)]
    segments = []  # (start, end, phase, dwell index)

    def add(duration, d, r, roll, phase, idx):
        t0 = keys[-1][0]
        keys.append((t0 + duration, d, r, roll))
        segments.append((t0, t0 + duration, phase, idx))

    add(lead_in_s, rest_dir, R + 120.0, 0.0, "idle", -1)
    gaps = []  # coil-to-scalp gap while held on each spot
    for i, dwell in enumerate(plan):
        d = dwell.spot.direction
        roll = np.radians(rng.uniform(-15, 15))
        gap = subject.hair_mm(dwell.spot) * HAIR_COMPRESSION + (1 - dwell.contact) * POOR_CONTACT_GAP_MM
        gaps.append(gap)
        add(transit_s, d, hover_r, roll, "transit", i)
        add(PLACE_S, d, R + gap, roll, "place", i)
        add(dwell.hold_s, d, R + gap, roll, "hold", i)
        add(LIFT_S, d, hover_r, roll, "lift", i)
    add(LEAD_OUT_S, keys[-1][1], keys[-1][2], keys[-1][3], "idle", -1)

    n = int(round(keys[-1][0] * sample_rate))
    dt = 1.0 / sample_rate
    t = np.arange(n) * dt
    seg_start = np.array([s[0] for s in segments])
    seg_end = np.array([s[1] for s in segments])
    k = np.clip(np.searchsorted(seg_end, t, side="right"), 0, len(segments) - 1)
    s = _min_jerk((t - seg_start[k]) / (seg_end[k] - seg_start[k]))
    key_dir = np.array([kf[1] for kf in keys])
    key_r = np.array([kf[2] for kf in keys])
    key_roll = np.array([kf[3] for kf in keys])
    dirs = _slerp(key_dir[k], key_dir[k + 1], s)
    radius = key_r[k] + s * (key_r[k + 1] - key_r[k])
    roll = key_roll[k] + s * (key_roll[k + 1] - key_roll[k])

    phase = np.array([segments[j][2] for j in k], dtype=object)
    dwell_idx = np.array([segments[j][3] for j in k])
    t_in_seg = t - seg_start[k]
    hold = phase == "hold"
    attached = np.isin(phase, ["place", "hold", "lift"])

    # Frequency: stepped through during each hold, otherwise the last one used.
    freq = np.full(n, np.nan)
    for i, dwell in enumerate(plan):
        mine = dwell_idx == i
        step = dwell.hold_s / len(dwell.freqs_hz)
        freq[mine & (phase == "place")] = dwell.freqs_hz[0]
        hold_i = mine & hold
        freq[hold_i] = np.array(dwell.freqs_hz)[np.minimum((t_in_seg[hold_i] / step).astype(int), len(dwell.freqs_hz) - 1)]
        freq[mine & (phase == "lift")] = dwell.freqs_hz[-1]
    freq = pd.Series(freq).ffill().fillna(plan[0].freqs_hz[0]).to_numpy()

    # Handling during holds: pressure wobble, plus scripted artifacts. Everything is kept
    # smooth so the IMU sees motion, not one-sample teleports.
    contact_r = np.array([R + gaps[i] if i >= 0 else np.inf for i in dwell_idx])
    near_contact = np.exp(-np.maximum(radius - contact_r, 0.0) / 2.0) * attached
    extra_lift = near_contact * _ou(n, dt, 0.05, 0.5, rng)
    tilt = np.zeros(n)
    shift = np.zeros((n, 3))
    shake = np.zeros(n)
    artifact = np.full(n, "", dtype=object)
    hold_start = {seg[3]: seg[0] for seg in segments if seg[2] == "hold"}
    fade_on_lift = np.where(phase == "lift", 1 - s, 1.0)
    for i, dwell in enumerate(plan):
        hold_i = (dwell_idx == i) & hold
        for a in dwell.artifacts:
            window = hold_i & (t_in_seg >= a.start_s) & (t_in_seg < a.start_s + a.duration_s)
            artifact[window] = a.kind
            if a.kind == "slip":
                # The probe slides sideways and stays there until it is lifted.
                t0 = hold_start[i] + a.start_s
                since = np.where((dwell_idx == i) & (hold | (phase == "lift")) & (t >= t0), t - t0, np.nan)
                tangent = np.cross(dwell.spot.direction, rng.normal(size=3))
                tangent /= np.linalg.norm(tangent)
                moved = np.nan_to_num(_min_jerk(since / 0.15)) * fade_on_lift
                shift += moved[:, None] * 8.0 * a.strength * tangent
                extra_lift += np.nan_to_num(2.0 * a.strength * _min_jerk(since / 0.1) * np.exp(-since / 0.3))
                continue
            since = t_in_seg[window] - a.start_s
            envelope = np.sin(np.pi * since / a.duration_s)
            if a.kind == "wobble":
                tilt[window] += np.radians(4.0 * a.strength) * envelope * np.sin(2 * np.pi * 3.0 * since)
                extra_lift[window] += 0.5 * COIL_RADIUS_MM * np.abs(np.sin(tilt[window]))
            elif a.kind == "lift":
                extra_lift[window] += 6.0 * a.strength * envelope
            elif a.kind == "shake":
                shake[window] = 0.15 * a.strength * envelope
                jitter = band_noise(t[window], (5.0, 15.0), 0.4 * a.strength, rng, axes=1)[:, 0]
                extra_lift[window] += np.abs(jitter) * envelope

    surface = dirs * R + shift
    dirs_eff = surface / np.linalg.norm(surface, axis=1, keepdims=True)
    liftoff = np.maximum(radius - R + extra_lift, 0.0)
    axes = _probe_axes(dirs_eff, roll, tilt)

    # --- Coil ---
    spot_sigma = np.full(n, subject.medium.sigma_tissue)
    spot_hair = np.zeros(n)
    spot_refl = np.full(n, subject.medium.reflectance)
    for i, dwell in enumerate(plan):
        mine = dwell_idx == i
        spot_sigma[mine] = subject.sigma(dwell.spot)
        spot_hair[mine & attached] = subject.hair_mm(dwell.spot)
        spot_refl[mine] = subject.reflectance(dwell.spot)
    coil_overlap = subject.bleed_overlap(dirs_eff, coil.decay_mm)
    sigma = spot_sigma + (subject.medium.sigma_bleed - subject.medium.sigma_tissue) * coil_overlap
    coil_dbm = coil.dbm(freq, sigma, liftoff)
    drift = coil.drift_db(t, rng)
    # The electronics warm up in the hand; a diode detector's output drifts with it.
    board_c = 25.0 + warmup_c * (1 - np.exp(-t / warmup_s))
    coil_v = detector.volts(coil_dbm + drift, board_c) + rng.normal(0, coil.noise_mv / 1000, n)

    # --- Optical ---
    optical_overlap = subject.bleed_overlap(dirs_eff, optical.decay_mm)
    od = spot_hair * subject.medium.hair_od_per_mm + subject.medium.bleed_od * optical_overlap
    beat = 2 * np.pi * subject.heart_rate_bpm / 60 * t
    pulse = subject.medium.pulse_frac * (np.sin(beat) + 0.3 * np.sin(2 * beat + 1.0)) / 1.3
    flicker_phase = rng.uniform(0, 2 * np.pi)
    tissue = optical.tissue_v(spot_refl, od, pulse, liftoff)
    ir_v = tissue + optical.crosstalk_v + optical.ambient_v(t, liftoff, flicker_phase)
    # The LED-off reading is taken a few ms before the LED-on one.
    ir_amb_v = optical.ambient_v(t - 0.003, liftoff, flicker_phase)
    ir_v = np.clip(ir_v + rng.normal(0, optical.noise_mv / 1000, n), 0, optical.rail_v)
    ir_amb_v = np.clip(ir_amb_v + rng.normal(0, optical.noise_mv / 1000, n), 0, optical.rail_v)

    # --- IMU ---
    up = np.array([0.0, 1.0, 0.0]) if posture == "supine" else np.array([0.0, 0.0, 1.0])
    imu_pos = dirs_eff * (R + liftoff)[:, None] - axes[:, :, 2] * IMU_OFFSET_MM
    accel_world = np.gradient(np.gradient(imu_pos, dt, axis=0), dt, axis=0) / 9810.0  # mm/s^2 -> g
    accel = np.einsum("nji,nj->ni", axes, accel_world + up)
    rot = Rotation.from_matrix(axes)
    gyro = np.degrees((rot[:-1].inv() * rot[1:]).as_rotvec()) / dt
    gyro = np.vstack([gyro, gyro[-1:]])
    accel += band_noise(t, imu.tremor_band_hz, imu.tremor_g, rng)
    gyro += band_noise(t, imu.tremor_band_hz, imu.tremor_dps, rng)
    accel += band_noise(t, (5.0, 15.0), 1.0, rng) * shake[:, None]
    gyro += band_noise(t, (5.0, 15.0), 60.0, rng) * shake[:, None]
    accel += rng.normal(0, imu.accel_bias_g, 3) + rng.normal(0, imu.accel_noise_g, (n, 3))
    gyro += rng.normal(0, imu.gyro_bias_dps, 3) + rng.normal(0, imu.gyro_noise_dps, (n, 3))

    accel_c = hw.accel_to_counts(accel)
    gyro_c = hw.gyro_to_counts(gyro)
    df = pd.DataFrame({
        "t_ms": np.round(t * 1000).astype(np.int64),
        "freq_hz": np.round(freq).astype(np.int64),
        "coil": hw.volts_to_counts(coil_v),
        "ir": hw.volts_to_counts(ir_v),
        "ir_amb": hw.volts_to_counts(ir_amb_v),
        "ax": accel_c[:, 0], "ay": accel_c[:, 1], "az": accel_c[:, 2],
        "gx": gyro_c[:, 0], "gy": gyro_c[:, 1], "gz": gyro_c[:, 2],
    })

    contact_ok = np.array([plan[i].contact >= 0.8 if i >= 0 else False for i in dwell_idx])
    spot_label = np.array([plan[i].spot.id if i >= 0 else "" for i in dwell_idx], dtype=object)
    df["true_phase"] = phase
    df["true_spot"] = np.where(attached, spot_label, "")
    df["true_dwell"] = np.where(attached, dwell_idx, -1)
    df["true_liftoff_mm"] = liftoff
    df["true_artifact"] = artifact
    df["true_good"] = hold & (artifact == "") & (t_in_seg >= SETTLE_S) & contact_ok
    df["true_sigma"] = sigma
    df["true_coil_overlap"] = coil_overlap
    df["true_coil_dbm"] = coil_dbm  # before drift and noise
    df["true_drift_db"] = drift
    df["true_optical_od"] = od
    df["true_board_c"] = board_c
    df.attrs["scenario"] = {
        "subject": subject.describe(),
        "bleeds": [str(b) for b in subject.bleeds],
        "bleed_sides": sorted({b.at.side for b in subject.bleeds}),
        "medium": subject.medium.name,
        "detector": detector.name,
        "drive_dbm": coil.drive_dbm,
        "posture": posture,
        "seed": seed,
    }
    return df


def raw_frames(session: pd.DataFrame) -> pd.DataFrame:
    """Only the columns the real device sends."""
    return session[list(hw.COLUMNS)]


def serial_lines(session: pd.DataFrame) -> list[str]:
    return [hw.HEADER] + [hw.format_frame(row) for row in raw_frames(session).itertuples(index=False)]


def pair_summary(session: pd.DataFrame) -> pd.DataFrame:
    """Mean coil level and optical density per left/right pair, over the truly good samples.

    Uses the ground-truth labels, so it checks a scenario; it is not a detector.
    """
    detector = hw.DETECTORS[session.attrs.get("scenario", {}).get("detector", hw.DEFAULT_DETECTOR.name)]
    units = hw.to_units(raw_frames(session), detector)
    good = session["true_good"].to_numpy()
    data = pd.DataFrame({
        "spot": session["true_spot"][good],
        "freq_hz": units["freq_hz"][good],
        "coil_dbm": units["coil_dbm"][good],
        "ir_net_v": units["ir_net_v"][good],
    })
    data["side"] = data["spot"].str[0]
    data["region"] = data["spot"].str[2:]
    means = data.groupby(["region", "freq_hz", "side"])[["coil_dbm", "ir_net_v"]].mean().unstack("side")
    out = pd.DataFrame(index=means.index)
    for side in ("L", "R"):
        out[f"coil_{side}_dbm"] = means.get(("coil_dbm", side))
        out[f"ir_{side}_v"] = means.get(("ir_net_v", side))
    out["coil_R_minus_L_db"] = out["coil_R_dbm"] - out["coil_L_dbm"]
    # Positive optical density difference = less light back from the right.
    out["od_R_minus_L"] = np.log10(out["ir_L_v"] / out["ir_R_v"])
    return out.reset_index()
