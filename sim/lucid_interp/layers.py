"""Turn raw probe frames into a layer estimate per spot and a left/right screening flag.

Per spot, the layers are:
  1. gap: hair and air between the coil face and the skin (mm), read from how much room
     light leaks in (IR receiver with the LED off), since the coil alone cannot tell a
     gap from weaker tissue.
  2. tissue: effective conductivity under the coil (S/m), from the coil loss after
     correcting for that gap with the coil model.
  3. optical density at 800 nm, after correcting for the gap.
A bleed shows up as higher conductivity than the mirror spot on the other side.

This is a model fit, not an image: at 3 MHz the coil field goes through the whole head
and the detector keeps no phase, so depth cannot be separated by frequency.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from scipy.optimize import brentq

from lucid_sim.anatomy import DEFAULT_SPOTS
from lucid_sim.channels import CoilModel, OpticalModel
from lucid_sim.hardware import COLUMNS, DEFAULT_DETECTOR, to_units

from .segment import Contact, coil_loss, find_contacts, mark_clean, sample_rate
from .spectral import Decomposition, decompose


@dataclass(frozen=True)
class Calibration:
    """Probe constants. The defaults match the simulator; replace them with bench measurements."""

    detector: object = DEFAULT_DETECTOR  # what turns coil amplitude into volts on the board
    coil: CoilModel = CoilModel()
    optical: OpticalModel = OpticalModel()
    reference_reflectance: float = 0.5  # skin reflectance that counts as optical density 0
    mains_hz: float = 60.0
    asymmetry_sd: float = 0.015  # S/m left/right difference expected on a healthy head
    flag_z: float = 3.0  # pair difference, in standard errors, that raises the flag
    large_gap_mm: float = 2.0  # warn above this
    max_gap_mm: float = 4.5  # retake above this: the coil barely sees tissue
    min_good_s: float = 1.0
    contact_threshold_db: float = -0.4
    dark_room_v: float = 0.02  # below this, room light is too dim to read the gap
    fallback_gap_mm: tuple[float, float] = (0.5, 1.0)  # mean, sd used when the gap cannot be read
    air_ref_se_db: float = 0.02  # uncertainty of the interpolated air level
    max_air_noise_db: float = 0.1  # per-sample coil noise in air above which the scan is not trusted


@dataclass
class Interpretation:
    layers: pd.DataFrame  # one row per spot and frequency
    spots: pd.DataFrame  # one row per spot, frequencies combined
    pairs: pd.DataFrame  # one row per region
    flag: dict
    contacts: list[Contact]
    units: pd.DataFrame = field(repr=False)
    loss_db: np.ndarray = field(repr=False)
    fs: float = 100.0
    calibration: Calibration = Calibration()

    def contact(self, spot: str) -> Contact:
        """The spot's contact; its latest one if it was rescanned."""
        for c in reversed(self.contacts):
            if c.spot == spot:
                return c
        raise KeyError(spot)

    def decomposition(self, spot: str, channel: str = "ir_net_v") -> Decomposition:
        """Fourier decomposition of one channel over the longest unbroken clean stretch of a spot's hold.

        Channels: any column of `units` (ir_net_v, ir_amb_v, ax_g, ...) or "coil_loss_db".
        """
        c = self.contact(spot)
        x = self.loss_db[c.slice] if channel == "coil_loss_db" else self.units[channel].to_numpy()[c.slice]
        start, end = longest_clean_run(c)
        return decompose(np.asarray(x, float)[start:end], self.fs, mains_hz=self.calibration.mains_hz)


def longest_clean_run(c: Contact) -> tuple[int, int]:
    """FFT needs evenly spaced samples, so use the longest gap-free run rather than patching holes."""
    padded = np.concatenate([[0], c.good.astype(np.int8), [0]])
    edges = np.flatnonzero(np.diff(padded))
    runs = list(zip(edges[::2], edges[1::2]))
    return max(runs, key=lambda r: r[1] - r[0]) if runs else (0, 0)


def _block_se(x: np.ndarray, fs: float, block_s: float = 0.5) -> float:
    """Standard error of the mean that respects slow wander, from means of half-second blocks."""
    size = max(1, int(block_s * fs))
    blocks = len(x) // size
    if blocks >= 3:
        means = x[: blocks * size].reshape(blocks, size).mean(axis=1)
        return float(means.std(ddof=1) / np.sqrt(blocks))
    return float(x.std(ddof=1) / np.sqrt(max(len(x) / 10, 1))) if len(x) > 1 else float("nan")


def invert_coil(loss_db: float, freq_hz: float, coil: CoilModel) -> tuple[float, float]:
    """Coil loss -> conductivity times coupling (S/m at zero gap), and d(loss)/d(that) for error propagation."""
    def loss(s):
        return coil.dbm(freq_hz, s, 0.0) - coil.dbm(freq_hz, 0.0, 0.0)

    s_max = 50.0
    if loss_db >= 0:
        s = 0.0
    elif loss(s_max) > loss_db:
        s = s_max
    else:
        s = brentq(lambda v: loss(v) - loss_db, 0.0, s_max)
    h = 1e-4
    slope = (loss(s + h) - loss(max(s - h, 0.0))) / (s + h - max(s - h, 0.0))
    return float(s), float(slope)


def _nearby_air_light(units: pd.DataFrame, in_air: np.ndarray, c: Contact, fs: float, window_s: float = 3.0):
    lo, hi = max(0, c.start - int(window_s * fs)), min(len(units), c.end + int(window_s * fs))
    idx = np.r_[lo:c.start, c.end:hi]
    idx = idx[in_air[idx]]
    light = units["ir_amb_v"].to_numpy()[idx]
    if len(light) < 5:
        return float("nan"), float("nan")
    return float(light.mean()), float(light.std(ddof=1) / np.sqrt(len(light) / 5))


def _gap_from_light(amb_contact, amb_contact_se, amb_air, amb_air_se, cal: Calibration):
    """Room light leaking under the probe: leak = 1 - exp(-gap / seal_mm)."""
    if not np.isfinite(amb_air) or amb_air < cal.dark_room_v:
        return cal.fallback_gap_mm[0], cal.fallback_gap_mm[1], "dark room: gap assumed"
    leak = float(np.clip(amb_contact / amb_air, 0.0, 0.95))
    leak_se = np.hypot(amb_contact_se / amb_air, leak * amb_air_se / amb_air)
    seal = cal.optical.seal_mm
    gap = -seal * np.log1p(-leak)
    gap_se = seal / (1 - leak) * leak_se
    # The leak model itself is approximate: allow 20% plus 0.1 mm.
    return float(gap), float(np.hypot(gap_se, 0.2 * gap + 0.1)), ""


def _assign_spots(contacts: list[Contact], spots) -> list[str]:
    notes = []
    for i, c in enumerate(contacts):
        c.spot = str(spots[i]) if i < len(spots) else f"extra-{i - len(spots) + 1}"
    if len(contacts) != len(spots):
        notes.append(f"found {len(contacts)} contacts for {len(spots)} planned spots; labels assigned in order")
    return notes


def _fit_contact(c: Contact, units, loss_db, in_air, fs, cal: Calibration) -> list[dict]:
    rows = []
    freqs = units["freq_hz"].to_numpy()[c.slice]
    amb_air, amb_air_se = _nearby_air_light(units, in_air, c, fs)
    for f in pd.unique(freqs):
        sel = c.good & (freqs == f)
        n_good = int(sel.sum())
        side, _, region = (c.spot or "").partition("-")
        row = {"spot": c.spot, "side": side, "region": region, "freq_hz": int(f),
               "good_s": n_good / fs, "status": "ok", "note": ""}
        if n_good < cal.min_good_s * fs:
            worst = max(c.rejected, key=c.rejected.get) if any(c.rejected.values()) else "short hold"
            row.update(status="retake", note=f"only {n_good / fs:.1f} s clean ({worst})")
            rows.append(row)
            continue

        loss = loss_db[c.slice][sel]
        loss_mean = float(loss.mean())
        loss_se = float(np.hypot(_block_se(loss, fs), cal.air_ref_se_db))
        s, slope = invert_coil(loss_mean, f, cal.coil)
        s_se = loss_se / abs(slope) if slope else float("inf")

        amb = units["ir_amb_v"].to_numpy()[c.slice][sel]
        gap, gap_se, note = _gap_from_light(amb.mean(), _block_se(amb, fs), amb_air, amb_air_se, cal)
        lam = cal.coil.liftoff_mm
        sigma = s * np.exp(gap / lam)
        sigma_se = float(np.hypot(np.exp(gap / lam) * s_se, sigma / lam * gap_se))

        opt = cal.optical
        net = units["ir_net_v"].to_numpy()[c.slice][sel].mean() - opt.crosstalk_v
        returned = max(net, 1e-4) * (1 + (gap / opt.falloff_mm) ** 2)
        od = float(-np.log10(returned / (opt.led_full_v * cal.reference_reflectance)))

        if gap > cal.max_gap_mm:
            row["status"] = "retake"
            note = f"gap {gap:.1f} mm: too far from the skin, press flatter"
        elif gap > cal.large_gap_mm:
            # The gap is measured and corrected for, so keep the spot, just with less sensitivity.
            note = f"gap {gap:.1f} mm (hair or poor contact): less sensitive"
        row.update(note=note, loss_db=loss_mean, loss_se=loss_se, s=s, s_se=s_se, gap_mm=gap, gap_se=gap_se,
                   sigma=sigma, sigma_se=sigma_se, od=od)
        rows.append(row)
    return rows


def _spectral_features(interp: "Interpretation") -> None:
    """Add Fourier features per spot: pulse, tremor, flicker, coil drift and noise."""
    extra = []
    for c in interp.contacts:
        run = longest_clean_run(c) if c.good is not None else (0, 0)
        if run[1] - run[0] < interp.fs:
            extra.append({"spot": c.spot})
            continue
        ir = interp.decomposition(c.spot, "ir_net_v")
        amb = interp.decomposition(c.spot, "ir_amb_v")
        coil = interp.decomposition(c.spot, "coil_loss_db")
        tremor = np.sqrt(sum(interp.decomposition(c.spot, f"a{a}_g").rms["tremor"] ** 2 for a in "xyz"))
        extra.append({
            "spot": c.spot,
            "pulse_bpm": ir.peak_hz["pulse"] * 60 if ir.snr["pulse"] > 3 else float("nan"),
            "pulse_snr": ir.snr["pulse"],
            "tremor_g": tremor,
            "flicker_v": amb.rms.get("flicker", float("nan")),
            "coil_drift_db_s": coil.slope_per_s,
            "coil_noise_db": coil.rms["noise"],
        })
    feats = pd.DataFrame(extra, columns=["spot", "pulse_bpm", "pulse_snr", "tremor_g", "flicker_v",
                                         "coil_drift_db_s", "coil_noise_db"]).drop_duplicates("spot", keep="last")
    interp.layers = interp.layers.merge(feats, on="spot", how="left")
    interp.spots = interp.spots.merge(feats, on="spot", how="left")


def _combine_spots(layers: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for spot, g in layers.groupby("spot", sort=False):
        ok = g[g["status"] == "ok"]
        row = {"spot": spot, "side": g["side"].iloc[0], "region": g["region"].iloc[0]}
        if ok.empty:
            row.update(status=g["status"].iloc[0], note=g["note"].iloc[0])
        else:
            w = 1 / ok["sigma_se"] ** 2
            row.update(status="ok", note="; ".join(n for n in ok["note"].unique() if n),
                       sigma=float((w * ok["sigma"]).sum() / w.sum()),
                       sigma_se=float(1 / np.sqrt(w.sum())), gap_mm=float(ok["gap_mm"].mean()),
                       gap_se=float(ok["gap_se"].mean()), od=float(ok["od"].mean()), good_s=float(ok["good_s"].sum()))
        rows.append(row)
    return pd.DataFrame(rows)


def _pairs(spots: pd.DataFrame, cal: Calibration) -> pd.DataFrame:
    rows = []
    by_spot = spots.set_index("spot")
    for region in dict.fromkeys(spots["region"]):
        if not region:
            continue
        row = {"region": region}
        sides = {s: by_spot.loc[f"{s}-{region}"] if f"{s}-{region}" in by_spot.index else None for s in "LR"}
        for s, r in sides.items():
            ok = r is not None and r["status"] == "ok"
            row[f"sigma_{s}"] = r["sigma"] if ok else np.nan
            row[f"sigma_{s}_se"] = r["sigma_se"] if ok else np.nan
            row[f"gap_{s}_mm"] = r["gap_mm"] if ok else np.nan
            row[f"od_{s}"] = r["od"] if ok else np.nan
        row["d_sigma"] = row["sigma_R"] - row["sigma_L"]
        row["d_sigma_se"] = np.sqrt(row["sigma_L_se"] ** 2 + row["sigma_R_se"] ** 2 + cal.asymmetry_sd**2)
        row["z"] = row["d_sigma"] / row["d_sigma_se"]
        row["d_od"] = row["od_R"] - row["od_L"]
        row["higher_side"] = "" if not np.isfinite(row["z"]) else ("R" if row["z"] > 0 else "L")
        rows.append(row)
    out = pd.DataFrame(rows)
    # A half-finished scan can leave a column all-missing, which pandas would store as objects.
    numeric = [c for c in out.columns if c not in ("region", "higher_side")]
    out[numeric] = out[numeric].astype(float)
    return out


def _flag(pairs: pd.DataFrame, spots: pd.DataFrame, cal: Calibration, notes: list[str]) -> dict:
    retake = spots.loc[spots["status"] != "ok", "spot"].tolist()
    tested = pairs[np.isfinite(pairs["z"])]
    hits = tested[tested["z"].abs() >= cal.flag_z]
    side_names = {"L": "left", "R": "right"}
    flag = {"status": "clear", "side": "", "regions": [], "max_z": float(tested["z"].abs().max()) if len(tested) else
            float("nan"), "retake": retake, "notes": notes}
    if tested.empty:
        reason = " ".join(f"{n[0].upper()}{n[1:]}." for n in notes) or "Retake: " + ", ".join(retake) + "."
        flag.update(status="incomplete", text="No complete left/right pair. " + reason)
        return flag
    if any(n.startswith("coil signal too weak") for n in notes):
        flag.update(status="incomplete", text="Coil signal too weak to trust: raise the drive level or use a "
                                              "Schottky diode, then rescan.")
        return flag
    if not hits.empty:
        sides = set(hits["higher_side"])
        # Rank by size, not z: the error grows with the signal, so z understates big bleeds.
        hits = hits.reindex(hits["d_sigma"].abs().sort_values(ascending=False).index)
        strongest = hits.iloc[0]
        if len(sides) > 1:
            flag.update(status="conflicting", regions=hits["region"].tolist(),
                        text="Asymmetries point to both sides. Retake the flagged pairs.")
        else:
            side = sides.pop()
            flag.update(status="asymmetry", side=side, regions=hits["region"].tolist(),
                        text=(f"Higher conductivity on the {side_names[side]}, strongest at {strongest['region']} "
                              f"(z = {abs(strongest['z']):.1f}). Screening flag, not a diagnosis."))
    else:
        flag["text"] = (f"No left/right asymmetry above z = {cal.flag_z:g} in {len(tested)} pairs. "
                        "Screening result, not a diagnosis.")
    if retake and flag["status"] != "incomplete":
        flag["text"] += " Retake: " + ", ".join(retake) + "."
    return flag


def interpret(frames: pd.DataFrame, spots=DEFAULT_SPOTS, calibration: Calibration = Calibration()) -> Interpretation:
    """Interpret one scan from raw frames (simulator or real device). Contacts are matched to `spots` in order."""
    cal = calibration
    units = to_units(frames[list(COLUMNS)], cal.detector)
    fs = sample_rate(units)
    loss_db, in_air = coil_loss(units, cal.coil, fs)
    contacts = find_contacts(loss_db, fs, threshold_db=cal.contact_threshold_db)
    notes = _assign_spots(contacts, spots)
    # A weak detector (low drive, silicon diode) shows up as a noisy coil level even in air.
    air_noise_db = 1.4826 * float(np.median(np.abs(loss_db[in_air] - np.median(loss_db[in_air])))) if in_air.any() \
        else float("nan")
    if not np.isfinite(air_noise_db) or air_noise_db > cal.max_air_noise_db:
        notes.append(f"coil signal too weak: {air_noise_db:.2f} dB noise in air "
                     "(raise the drive level or use a Schottky diode)")
    if not contacts:
        notes.append("no contacts found on the coil")

    on_head = np.zeros(len(units), bool)
    for c in contacts:
        on_head[c.slice] = True
    gyro_bias = np.median(units[["gx_dps", "gy_dps", "gz_dps"]].to_numpy()[on_head], axis=0) if on_head.any() \
        else np.zeros(3)
    for c in contacts:
        mark_clean(units, loss_db, c, fs, gyro_bias)

    rows = [r for c in contacts for r in _fit_contact(c, units, loss_db, in_air, fs, cal)]
    layers = pd.DataFrame(rows)
    spot_table = _combine_spots(layers) if len(layers) else pd.DataFrame(columns=["spot", "side", "region", "status"])
    pairs = _pairs(spot_table, cal) if len(layers) else pd.DataFrame({"region": pd.Series(dtype=str), "z": pd.Series(dtype=float)})
    flag = _flag(pairs, spot_table, cal, notes)
    interp = Interpretation(layers, spot_table, pairs, flag, contacts, units, loss_db, fs, cal)
    if contacts:
        _spectral_features(interp)
        # Each hold is only ~3 heartbeats, so a single spot's rate is rough; the median across spots is steadier.
        bpm = interp.spots["pulse_bpm"].dropna()
        flag["heart_rate_bpm"] = float(bpm.median()) if len(bpm) >= 3 else float("nan")
    return interp
