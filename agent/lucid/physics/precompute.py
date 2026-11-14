"""Precompute the hypothesis table: `python -m lucid.physics.precompute` (from agent/).

Rebuilds the head mesh (data/head_mesh.npz), runs the live forward model for all 192 grid
hypotheses plus the healthy head, and writes data/sim_table.json (values rounded to 4 dp).
"""
from __future__ import annotations

import json
import time

import numpy as np

from . import DATA_DIR, NULL_ID, TABLE_PATH, all_hypotheses, forward, null_reading
from .headmodel import MESH_PATH, _gains, build_mesh, model


def main() -> None:
    t0 = time.perf_counter()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    nodes, tri = build_mesh()
    np.savez_compressed(MESH_PATH, node=nodes, element=tri)
    model.cache_clear()  # make sure the table is computed on the mesh just saved
    _gains.cache_clear()

    def rounded(reading: dict) -> dict:
        return {k: [round(float(x), 4) for x in v] for k, v in reading.items()}

    readings = {NULL_ID: rounded(null_reading())}
    for h in all_hypotheses():
        readings[h["id"]] = rounded(forward(h["type"], h["region"], h["volume_ml"]))
    meta = {
        "model": "2D pyEIT proxy (see lucid/physics/headmodel.py)",
        "mesh": {"nodes": int(len(nodes)), "elements": int(len(tri))},
        "n_hypotheses": len(readings) - 1,
    }
    TABLE_PATH.write_text(json.dumps({"meta": meta, "readings": readings}, separators=(",", ":")) + "\n")
    print(f"wrote {TABLE_PATH} ({len(readings)} readings, {TABLE_PATH.stat().st_size / 1024:.0f} kB) "
          f"and {MESH_PATH.name} in {time.perf_counter() - t0:.1f} s")


if __name__ == "__main__":
    main()
