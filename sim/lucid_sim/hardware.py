"""Hardware constants, unit conversions and the serial frame format.

The simulator writes frames in this format and the laptop app should read the real
Arduino with the same parser, so the firmware must print exactly these columns.

Signal chain: AD9833 -> coil -> detector -> ADS1115 A0. The detector is a diode peak
detector (the AD8307 did not arrive); the AD8307 model is kept in case it turns up.
IR receiver -> ADS1115 A1, read once with the LED on (ir) and once with it off (ir_amb).
GY-521 (MPU-6050) on I2C.

Coil levels are in dBm into 50 ohm at the detector input: 0 dBm is 0.32 V peak, about
what the AD9833 puts out on its own.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

import numpy as np
import pandas as pd
from scipy.special import i0e

SAMPLE_RATE_HZ = 100

# ADS1115 at PGA ±4.096 V: 125 µV per count.
ADS_FULL_SCALE_V = 4.096
ADS_LSB_V = ADS_FULL_SCALE_V / 32768


def dbm_to_peak_v(dbm):
    return np.sqrt(2 * 50.0 * 1e-3 * 10 ** (np.asarray(dbm, float) / 10))


def peak_v_to_dbm(peak_v):
    return 10 * np.log10(np.maximum(np.asarray(peak_v, float), 1e-12) ** 2 / (2 * 50.0 * 1e-3))


@dataclass(frozen=True)
class AD8307:
    """Log detector, datasheet typical values: 25 mV/dB, intercept -84 dBm."""

    name: str = "ad8307"
    slope_v_per_db: float = 0.025
    intercept_dbm: float = -84.0
    max_v: float = 2.6

    def volts(self, dbm, temp_c=25.0):
        return np.clip(self.slope_v_per_db * (np.asarray(dbm) - self.intercept_dbm), 0.0, self.max_v)

    def dbm(self, volts, temp_c=25.0):
        return np.asarray(volts) / self.slope_v_per_db + self.intercept_dbm


@dataclass(frozen=True)
class DiodeDetector:
    """Diode peak detector: diode in series, hold capacitor and load resistor to ground.

    Solves the standard peak-detector balance, Vout / R = Is * (I0(Vp / nVt) * exp(-Vout / nVt) - 1),
    so it is square-law at small signals (Vout ~ Vp^2), linear at large ones (Vout ~ Vp - drop),
    and drifts with temperature through Is and Vt.
    """

    name: str = "schottky"
    saturation_a: float = 1e-7  # Is at 25 °C
    ideality: float = 1.05
    load_ohm: float = 10e3  # discharge resistor (in parallel with the ADS1115 input)
    is_doubling_c: float = 10.0  # Is roughly doubles every this many °C

    def _params(self, temp_c):
        temp_c = np.asarray(temp_c, float)
        n_vt = self.ideality * 8.617e-5 * (temp_c + 273.15)
        i_s = self.saturation_a * 2 ** ((temp_c - 25.0) / self.is_doubling_c)
        return n_vt, i_s

    def _balance(self, vout, n_vt, i_s):
        return np.log1p(vout / (self.load_ohm * i_s)) + vout / n_vt

    def volts(self, dbm, temp_c=25.0):
        vp = dbm_to_peak_v(dbm)
        n_vt, i_s = self._params(temp_c)
        x = vp / n_vt
        target = np.log(i0e(x)) + x  # ln I0(x), computed without overflow
        lo, hi = np.zeros_like(vp), vp.copy()
        for _ in range(60):  # bisection: the balance rises steadily with Vout
            mid = (lo + hi) / 2
            low = self._balance(mid, n_vt, i_s) < target
            lo, hi = np.where(low, mid, lo), np.where(low, hi, mid)
        return (lo + hi) / 2

    def dbm(self, volts, temp_c=25.0):
        vout = np.maximum(np.asarray(volts, float), 0.0)
        n_vt, i_s = self._params(temp_c)
        target = self._balance(vout, n_vt, i_s)
        # ln I0(x) = x - ln(2 pi x)/2 + ..., so x sits a little above target.
        lo, hi = np.zeros_like(vout), 2 * target + 10.0
        for _ in range(60):
            mid = (lo + hi) / 2
            low = np.log(i0e(mid)) + mid < target
            lo, hi = np.where(low, mid, lo), np.where(low, hi, mid)
        return peak_v_to_dbm((lo + hi) / 2 * n_vt)


DETECTORS = {
    # TODO(hardware): get the exact Schottky part on the board (BAT43? BAT85? 1N5817?) and set its Is and
    # ideality from the datasheet. Only the absolute conductivity depends on it (a few %); the L/R flag doesn't.
    "schottky": DiodeDetector(),
    # Plain silicon small-signal diode: bigger drop, so weaker at low drive.
    "1n4148": DiodeDetector(name="1n4148", saturation_a=4e-9, ideality=1.9),
    "ad8307": AD8307(),
}
DEFAULT_DETECTOR = DETECTORS["schottky"]

# MPU-6050 at its default ranges, ±2 g and ±250 °/s.
ACCEL_COUNTS_PER_G = 16384
GYRO_COUNTS_PER_DPS = 131

# One frame per line, integers only, so the Arduino can Serial.print them cheaply.
COLUMNS = ("t_ms", "freq_hz", "coil", "ir", "ir_amb", "ax", "ay", "az", "gx", "gy", "gz")
HEADER = "# lucid v1 " + ",".join(COLUMNS)


def _int16(x) -> np.ndarray:
    return np.clip(np.round(x), -32768, 32767).astype(np.int32)


def volts_to_counts(volts) -> np.ndarray:
    return _int16(np.asarray(volts) / ADS_LSB_V)


def accel_to_counts(g) -> np.ndarray:
    return _int16(np.asarray(g) * ACCEL_COUNTS_PER_G)


def gyro_to_counts(dps) -> np.ndarray:
    return _int16(np.asarray(dps) * GYRO_COUNTS_PER_DPS)


def format_frame(values: Iterable) -> str:
    return ",".join(str(int(v)) for v in values)


def parse_frame(line: str) -> dict | None:
    """Parse one serial line. Returns None for comments, blanks and garbled lines."""
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    parts = line.split(",")
    if len(parts) != len(COLUMNS):
        return None
    try:
        values = [int(p) for p in parts]
    except ValueError:
        return None
    return dict(zip(COLUMNS, values))


def read_frames(lines: Iterable[str]) -> pd.DataFrame:
    rows = [row for line in lines if (row := parse_frame(line)) is not None]
    return pd.DataFrame(rows, columns=list(COLUMNS))


def read_serial_log(path) -> pd.DataFrame:
    with open(path) as f:
        return read_frames(f)


def to_units(frames: pd.DataFrame, detector=DEFAULT_DETECTOR) -> pd.DataFrame:
    """Add physical-unit columns to raw frames (from the simulator or the real device)."""
    df = frames.copy()
    df["t_s"] = df["t_ms"] / 1000.0
    df["coil_v"] = df["coil"] * ADS_LSB_V
    df["coil_dbm"] = detector.dbm(df["coil_v"].to_numpy())
    df["ir_v"] = df["ir"] * ADS_LSB_V
    df["ir_amb_v"] = df["ir_amb"] * ADS_LSB_V
    df["ir_net_v"] = df["ir_v"] - df["ir_amb_v"]
    for axis in "xyz":
        df[f"a{axis}_g"] = df[f"a{axis}"] / ACCEL_COUNTS_PER_G
        df[f"g{axis}_dps"] = df[f"g{axis}"] / GYRO_COUNTS_PER_DPS
    return df
