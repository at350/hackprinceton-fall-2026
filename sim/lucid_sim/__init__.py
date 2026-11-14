"""Lucid probe simulator: raw serial frames from the handheld, with ground truth, before the hardware exists."""
from .anatomy import BLEED_KINDS, DEFAULT_SPOTS, HUMAN, MEDIA, REGIONS, SALINE_PHANTOM, Bleed, Medium, Spot, Subject
from .channels import CoilModel, ImuModel, OpticalModel
from .hardware import (AD8307, COLUMNS, DEFAULT_DETECTOR, DETECTORS, HEADER, DiodeDetector, parse_frame, read_frames,
                       read_serial_log, to_units)
from .session import (ARTIFACT_KINDS, Artifact, Dwell, add_random_artifacts, default_plan, pair_summary,
                      raw_frames, serial_lines, simulate)

__all__ = [
    "AD8307", "DEFAULT_DETECTOR", "DETECTORS", "DiodeDetector",
    "ARTIFACT_KINDS", "Artifact", "BLEED_KINDS", "Bleed", "COLUMNS", "CoilModel", "DEFAULT_SPOTS", "Dwell",
    "HEADER", "HUMAN", "ImuModel", "MEDIA", "Medium", "OpticalModel", "REGIONS", "SALINE_PHANTOM", "Spot",
    "Subject", "add_random_artifacts", "default_plan", "pair_summary", "parse_frame", "raw_frames",
    "read_frames", "read_serial_log", "serial_lines", "simulate", "to_units",
]
