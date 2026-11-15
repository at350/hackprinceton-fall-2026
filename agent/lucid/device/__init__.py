"""The Lucid probe on the laptop side: serial reader, calibration, spot capture and the device bridge.

    python -m lucid.device              # find the probe, serve the bridge on http://localhost:2025
    python -m lucid.device --simulate   # no probe: a synthetic stream, for trying the bridge and the dashboard

Nothing here imports the agent or the physics model, so the bridge starts fast and runs without API keys.
"""
from __future__ import annotations

SCAN_ID = "device"  # the scan_id the dashboard sends in Device mode
N_SPOTS = 8
SPOT_NAMES = ["Frontal", "R frontal", "R temporal", "R parietal", "Occipital", "L parietal", "L temporal", "L frontal"]
