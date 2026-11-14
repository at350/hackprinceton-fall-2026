"""Fourier decomposition of a held-spot time series into physical components.

The spectrum is split into bands (slow drift, cardiac pulse, hand tremor, room-light
flicker, everything else). Each band is inverse-transformed back to a time series, so
the components add up exactly to the original signal and can be plotted or measured.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class Band:
    name: str
    lo_hz: float
    hi_hz: float


def flicker_alias_hz(fs: float, mains_hz: float = 60.0) -> float:
    """Where room-light flicker (twice mains) lands after sampling at fs."""
    f = 2 * mains_hz
    return abs(((f + fs / 2) % fs) - fs / 2)


def default_bands(fs: float, mains_hz: float = 60.0) -> list[Band]:
    """Earlier bands win where they overlap. Flicker is skipped if it aliases onto DC (50 Hz mains at 100 Hz)."""
    bands = [Band("drift", 0.0, 0.5), Band("pulse", 0.7, 3.5), Band("tremor", 6.0, 14.0)]
    alias = flicker_alias_hz(fs, mains_hz)
    if alias > 1.0:
        bands.insert(0, Band("flicker", alias - 0.75, alias + 0.75))
    return bands


@dataclass
class Decomposition:
    fs: float
    signal: np.ndarray
    trend: np.ndarray  # straight-line fit, removed before the FFT
    slope_per_s: float
    components: dict[str, np.ndarray]  # band name -> time series; "noise" holds everything unassigned
    rms: dict[str, float]
    peak_hz: dict[str, float]
    snr: dict[str, float]  # band power over what white noise at the "noise" density would give

    @property
    def t_s(self) -> np.ndarray:
        return np.arange(len(self.signal)) / self.fs

    def reconstruct(self) -> np.ndarray:
        return self.trend + sum(self.components.values())


def peak_frequency(x: np.ndarray, fs: float, lo_hz: float, hi_hz: float, pad: int = 8) -> float:
    """Peak in a band, from a zero-padded Hann-windowed spectrum (finer than the raw bin spacing)."""
    x = np.asarray(x, float) - np.mean(x)
    n = len(x) * pad
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x)), n))
    freqs = np.fft.rfftfreq(n, 1 / fs)
    band = (freqs >= lo_hz) & (freqs <= hi_hz)
    return float(freqs[band][np.argmax(spec[band])]) if band.any() else float("nan")


def decompose(x, fs: float, bands: list[Band] | None = None, mains_hz: float = 60.0) -> Decomposition:
    x = np.asarray(x, float)
    n = len(x)
    bands = bands if bands is not None else default_bands(fs, mains_hz)
    t = np.arange(n) / fs
    slope, intercept = np.polyfit(t, x, 1) if n > 1 else (0.0, float(x.mean()))
    trend = slope * t + intercept
    spec = np.fft.rfft(x - trend)
    freqs = np.fft.rfftfreq(n, 1 / fs)

    assigned = np.zeros(len(freqs), bool)
    components, bins, peak = {}, {}, {}
    for band in bands:
        mask = (freqs >= band.lo_hz) & (freqs < band.hi_hz) & ~assigned
        assigned |= mask
        components[band.name] = np.fft.irfft(np.where(mask, spec, 0), n)
        bins[band.name] = int(mask.sum())
        peak[band.name] = peak_frequency(x - trend, fs, band.lo_hz, band.hi_hz)
    components["noise"] = np.fft.irfft(np.where(~assigned, spec, 0), n)
    bins["noise"] = int((~assigned).sum())

    rms = {k: float(np.sqrt(np.mean(v**2))) for k, v in components.items()}
    density = rms["noise"] ** 2 / max(bins["noise"], 1)
    snr = {k: (rms[k] ** 2 / (density * bins[k]) if bins[k] and density > 0 else float("nan")) for k in components}
    return Decomposition(fs, x, trend, float(slope), components, rms, peak, snr)
