"""Sources of raw samples: the probe on a serial port, or a synthetic stream for trying things without it."""
from __future__ import annotations

import math
import os
import random
import threading
import time
from typing import Callable

from .protocol import Hello, RawSample, parse_line

BAUD = 115200
RETRY_S = 2.0
SILENT_S = 3.0  # no valid line for this long: the port is open but nothing useful is coming

OnSample = Callable[[RawSample], None]


def find_port() -> str | None:
    """LUCID_SERIAL_PORT if set, else the first port that looks like an Arduino."""
    if port := os.getenv("LUCID_SERIAL_PORT"):
        return port
    from serial.tools import list_ports  # pyserial

    ports = list(list_ports.comports())

    def looks_right(p) -> bool:
        text = f"{p.device} {p.description} {p.manufacturer or ''}".lower()
        return p.vid in (0x2341, 0x2A03, 0x1A86, 0x10C4, 0x0403) or any(k in text for k in ("arduino", "usbmodem", "ttyacm", "ch340", "wchusb"))

    for p in ports:
        if looks_right(p):
            return p.device
    return None


class Source:
    """Common state the bridge reads: whether a probe is there, and why not."""

    connected = False
    reason = "Starting"
    port: str | None = None
    hello: Hello | None = None

    def start(self) -> None: ...
    def stop(self) -> None: ...


class SerialSource(Source):
    """Reads the probe on a background thread and reconnects when the cable is pulled."""

    def __init__(self, on_sample: OnSample, port: str | None = None) -> None:
        self.on_sample = on_sample
        self.fixed_port = port
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="lucid-serial", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)

    def _run(self) -> None:
        import serial  # pyserial

        while not self._stop.is_set():
            port = self.fixed_port or find_port()
            if not port:
                self.connected, self.port, self.reason = False, None, "No probe found on USB"
                self._stop.wait(RETRY_S)
                continue
            try:
                with serial.Serial(port, BAUD, timeout=1) as ser:
                    self.port, self.reason = port, f"Opened {port}, waiting for the probe"
                    time.sleep(2.0)  # the Uno resets when the port opens
                    ser.reset_input_buffer()
                    ser.write(b"?")
                    last_good = time.monotonic()
                    while not self._stop.is_set():
                        got = parse_line(ser.readline())
                        if isinstance(got, Hello):
                            self.hello = got
                            if not got.ads:
                                self.reason = "The probe's ADC (ADS1115) did not answer"
                        elif isinstance(got, RawSample):
                            last_good = time.monotonic()
                            if not self.connected:
                                self.connected, self.reason = True, ""
                            self.on_sample(got)
                        elif time.monotonic() - last_good > SILENT_S:
                            self.connected = False
                            self.reason = f"{port} is open but the probe is not sending readings"
            except (OSError, serial.SerialException) as e:
                self.reason = f"Lost the probe on {port}: {e.__class__.__name__}"
            self.connected = False
            self._stop.wait(RETRY_S)


class SimulatedSource(Source):
    """A synthetic probe for trying the bridge and the dashboard with nothing plugged in.

    It is not a model of the hardware: steady volts with a little noise, and a tilt that
    holds still for a while and then swings to a new pose, the way a medic moves between spots.
    """

    def __init__(self, on_sample: OnSample, seed: int = 1, rate_hz: float = 50.0) -> None:
        self.on_sample = on_sample
        self.rate_hz = rate_hz
        self.rng = random.Random(seed)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self.connected, self.reason, self.port = True, "", "simulated"
        self.hello = Hello(fw="simulated", ads=True, imu=True)
        self._thread = threading.Thread(target=self._run, name="lucid-sim", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def samples(self, n: int, t0: int = 0):
        """n samples starting at t0 ms (also used directly by the tests)."""
        step = 1000.0 / self.rate_hz
        for i in range(n):
            t = t0 + int(i * step)
            phase = (t / 1000.0) % 3.0  # 2 s still, 1 s moving
            pose = int(t / 3000.0)
            base_pitch, base_roll = 18 * math.cos(pose * 0.785), 30 * math.sin(pose * 0.785)
            swing = 12 * math.sin((phase - 2.0) * math.pi) if phase > 2.0 else 0.0
            yield RawSample(
                t=t,
                coil_v=0.80 + self.rng.gauss(0, 0.0015),
                nir_v=0.45 + self.rng.gauss(0, 0.0008),
                pitch=round(base_pitch + swing + self.rng.gauss(0, 0.15), 1),
                roll=round(base_roll + swing + self.rng.gauss(0, 0.15), 1),
            )

    def _run(self) -> None:
        t0 = time.monotonic()
        step = 1.0 / self.rate_hz
        i = 0
        gen = self.samples(10**9)
        while not self._stop.is_set():
            self.on_sample(next(gen))
            i += 1
            self._stop.wait(max(0.0, t0 + i * step - time.monotonic()))
