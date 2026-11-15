"""Physics of the three sensing channels. Defaults are set per probe by the bench calibration (README)."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class CoilModel:
    """Coil as a resonant tank. Conductive tissue near the face adds eddy-current loss,
    which lowers Q and so the amplitude the detector sees. Blood is more conductive than
    the tissue around it, so a bleed under the coil reads a little lower (more loss)."""

    f0_hz: float = 3.0e6  # tank resonance
    q_air: float = 30.0
    loading: float = 0.021  # 1/Q added per S/m of tissue, in full contact, at f0
    liftoff_mm: float = 6.0  # coupling to tissue falls by e for every this many mm of gap
    decay_mm: float = 15.0  # how deep the coil sees
    # Bench calibration: the peak volts at the diode at 3 MHz, probe in air (dBm = 20*log10(Vpeak / 0.316)).
    # Below ~0.1 V peak the Schottky can't resolve a bleed.
    drive_dbm: float = 0.0  # level at the detector at resonance, in air (0 dBm = 0.32 V peak, the AD9833 alone)
    noise_mv: float = 1.0  # detector output noise per sample
    warmup_db: float = 0.15  # gain drop as the probe warms in the hand
    warmup_s: float = 60.0
    drift_db_per_rt_s: float = 0.005  # random-walk gain drift

    def dbm(self, freq_hz, sigma, liftoff_mm):
        x = np.asarray(freq_hz) / self.f0_hz
        coupling = np.exp(-np.maximum(liftoff_mm, 0.0) / self.liftoff_mm)
        inv_q = 1 / self.q_air + self.loading * x**2 * sigma * coupling
        q = 1 / inv_q
        gain = (q / self.q_air) / np.sqrt(1 + (q * (x - 1 / x)) ** 2)
        return self.drive_dbm + 20 * np.log10(gain)

    def drift_db(self, t_s: np.ndarray, rng: np.random.Generator) -> np.ndarray:
        dt = np.diff(t_s, prepend=t_s[0])
        walk = np.cumsum(rng.normal(0, 1, len(t_s)) * self.drift_db_per_rt_s * np.sqrt(dt))
        return -self.warmup_db * (1 - np.exp(-t_s / self.warmup_s)) + walk


@dataclass(frozen=True)
class OpticalModel:
    """800 nm LED and IR receiver side by side on the front disk. Blood absorbs at 800 nm,
    so less light comes back over a bleed. Room light leaks in when the seal is poor."""

    led_full_v: float = 2.5  # receiver output for a perfect reflector at contact
    crosstalk_v: float = 0.05  # LED light reaching the receiver inside the case
    room_v: float = 0.4  # receiver output from room light with the probe in the air
    flicker_hz: float = 120.0  # mains lighting flicker (aliases at the sample rate)
    flicker_frac: float = 0.2
    seal_mm: float = 1.5  # ambient leak = 1 - exp(-liftoff / seal_mm)
    falloff_mm: float = 3.0  # returned light falls as 1 / (1 + (liftoff / falloff)^2)
    decay_mm: float = 6.0  # how deep the optical channel sees (source and detector are close)
    noise_mv: float = 2.0
    rail_v: float = 3.3

    def ambient_v(self, t_s, liftoff_mm, phase: float) -> np.ndarray:
        flicker = 1 + self.flicker_frac * np.sin(2 * np.pi * self.flicker_hz * t_s + phase)
        return self.room_v * flicker * (1 - np.exp(-np.maximum(liftoff_mm, 0.0) / self.seal_mm))

    def tissue_v(self, reflectance, od, pulse, liftoff_mm) -> np.ndarray:
        returned = self.led_full_v * reflectance * 10 ** (-od) * (1 + pulse)
        return returned / (1 + (np.maximum(liftoff_mm, 0.0) / self.falloff_mm) ** 2)


@dataclass(frozen=True)
class ImuModel:
    accel_noise_g: float = 0.004
    gyro_noise_dps: float = 0.15
    accel_bias_g: float = 0.02  # per-axis sd, fixed for a session
    gyro_bias_dps: float = 1.5
    tremor_g: float = 0.008  # physiological hand tremor, rms
    tremor_dps: float = 0.6
    tremor_band_hz: tuple[float, float] = (8.0, 12.0)


def band_noise(t_s: np.ndarray, band_hz: tuple[float, float], rms: float, rng: np.random.Generator,
               axes: int = 3, tones: int = 5) -> np.ndarray:
    """Cheap band-limited noise: a few random tones in the band with a slow wobble, shape (N, axes)."""
    out = np.zeros((len(t_s), axes))
    for a in range(axes):
        freqs = rng.uniform(*band_hz, tones)
        phases = rng.uniform(0, 2 * np.pi, tones)
        out[:, a] = np.sin(2 * np.pi * freqs[None, :] * t_s[:, None] + phases[None, :]).sum(axis=1)
    envelope = 1 + 0.3 * np.sin(2 * np.pi * 0.2 * t_s + rng.uniform(0, 2 * np.pi))
    return out * envelope[:, None] * rms / np.sqrt(tones / 2)
