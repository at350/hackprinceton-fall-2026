"""Lucid physics: head geometry, pyEIT forward proxy, hypothesis grid, fit and mock scans.

Public API used by the agent backend. See headmodel.py for what the model is (and is not).
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from .headmodel import forward, null_reading
from .geometry import BLEED_TYPES, LOBES, REGION_ANGLE, SPOT_NAMES, VOLUMES, hypothesis_map
from .scans import MOCK_CASES, fit, likelihood_map, mock_scan, spot_peaks

DATA_DIR = Path(__file__).resolve().parents[2] / "data"
TABLE_PATH = DATA_DIR / "sim_table.json"
NULL_ID = "null"

_TYPE_CODE = {"epidural": "epi", "subdural": "sub", "intraparenchymal": "iph"}
_CODE_TYPE = {v: k for k, v in _TYPE_CODE.items()}
# "L temporal" <-> "LT"
_REGION_CODE = {r: r[0] + r.split()[1][0].upper() for r in REGION_ANGLE}
_CODE_REGION = {v: k for k, v in _REGION_CODE.items()}


def hypothesis_id(type: str, region: str, volume_ml: int) -> str:
    """e.g. ("epidural", "L temporal", 20) -> "epi-LT-20"; volume zero-padded to 2 digits."""
    return f"{_TYPE_CODE[type]}-{_REGION_CODE[region]}-{int(round(volume_ml)):02d}"


def parse_hypothesis_id(hid: str) -> dict:
    """"epi-LT-20" -> {"id", "type", "region", "volume_ml", "agent"}; agent = lobe."""
    try:
        t, r, v = hid.split("-")
        region = _CODE_REGION[r]
        return {"id": hid, "type": _CODE_TYPE[t], "region": region, "volume_ml": int(v), "agent": region.split()[1]}
    except (ValueError, KeyError) as e:
        raise ValueError(f"bad hypothesis id {hid!r}") from e


def all_hypotheses() -> list[dict]:
    """The full grid: 3 types x 8 regions x 8 volumes = 192."""
    return [
        parse_hypothesis_id(hypothesis_id(t, r, v)) for t in BLEED_TYPES for r in REGION_ANGLE for v in VOLUMES
    ]


@lru_cache(maxsize=1)
def _table() -> dict:
    try:
        return json.loads(TABLE_PATH.read_text())["readings"]
    except (OSError, ValueError, KeyError):
        return {}


def lookup(hid: str) -> dict:
    """Precomputed reading for a grid hypothesis (data/sim_table.json, loaded once).
    Falls back to a live forward() solve when the table or the entry is missing."""
    hit = _table().get(hid)
    if hit is not None:
        return {"coil_db": list(hit["coil_db"]), "nir": list(hit["nir"])}
    if hid == NULL_ID:
        return null_reading()
    h = parse_hypothesis_id(hid)
    return forward(h["type"], h["region"], h["volume_ml"])


__all__ = [
    "BLEED_TYPES",
    "REGION_ANGLE",
    "LOBES",
    "VOLUMES",
    "SPOT_NAMES",
    "MOCK_CASES",
    "hypothesis_id",
    "parse_hypothesis_id",
    "all_hypotheses",
    "forward",
    "lookup",
    "null_reading",
    "fit",
    "hypothesis_map",
    "likelihood_map",
    "spot_peaks",
    "mock_scan",
]
