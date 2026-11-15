"""`python -m lucid.device`: find the probe and serve the device bridge."""
from __future__ import annotations

import argparse
import os

from . import calibrate
from .bridge import Bridge
from .reader import SerialSource, SimulatedSource
from .server import DEFAULT_PORT, serve


def main() -> None:
    ap = argparse.ArgumentParser(description="Lucid device bridge")
    ap.add_argument("--serial", default=os.getenv("LUCID_SERIAL_PORT"), help="serial port of the probe (default: find it)")
    ap.add_argument("--http", type=int, default=int(os.getenv("LUCID_DEVICE_PORT", DEFAULT_PORT)), help="port to serve on")
    ap.add_argument("--simulate", action="store_true", help="no probe: a synthetic stream (not a model of the hardware)")
    args = ap.parse_args()

    bridge = Bridge(calibration=calibrate.load())
    source = SimulatedSource(bridge.on_sample) if args.simulate else SerialSource(bridge.on_sample, port=args.serial)
    bridge.source = source
    source.start()
    server = serve(bridge, args.http)
    what = "a simulated probe" if args.simulate else (f"the probe on {args.serial}" if args.serial else "the probe (searching USB)")
    print(f"Lucid device bridge on http://localhost:{args.http}, reading {what}.")
    print("Calibrated." if bridge.cal else "Not calibrated yet: POST /calibrate with the probe held on the healthy reference.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        source.stop()
        server.server_close()


if __name__ == "__main__":
    main()
