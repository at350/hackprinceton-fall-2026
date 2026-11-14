"""Build static/brain.json from the fsaverage5 cortex (FreeSurfer's template, as bundled with nilearn).

    python -m lucid_ui.make_brain path/to/fsaverage5      # folder with pial_left.gii.gz, sulc_left.gii.gz, ...

Reads GIFTI with the standard library only. The cortex is fitted inside the model head (a 90 mm sphere with
12 mm of scalp and skull) along each axis, so the bleed fit and the picture share one frame:
+x right ear, +y nose, +z crown, mm. FreeSurfer's RAS axes already point that way.
"""
from __future__ import annotations

import base64
import gzip
import json
import sys
import xml.etree.ElementTree as ET
import zlib
from pathlib import Path

import numpy as np

from lucid_sim.anatomy import HEAD_RADIUS_MM

OUT = Path(__file__).parent / "static" / "brain.json"
HALF_EXTENT_MM = np.array([68.0, 76.0, 60.0])  # brain half-size inside the head, x y z
CENTRE_Z_MM = 8.0  # the cortex sits a little above the ear line
INNER_RADIUS_MM = HEAD_RADIUS_MM - 12.0
DTYPES = {"NIFTI_TYPE_FLOAT32": "<f4", "NIFTI_TYPE_INT32": "<i4", "NIFTI_TYPE_UINT8": "u1"}


def read_gifti(path: Path) -> list[np.ndarray]:
    raw = path.read_bytes()
    if path.suffix == ".gz":
        raw = gzip.decompress(raw)
    arrays = []
    for da in ET.fromstring(raw).iter("DataArray"):
        dims = [int(da.get(f"Dim{i}")) for i in range(int(da.get("Dimensionality")))]
        text = da.find("Data").text.strip()
        enc = da.get("Encoding")
        if enc == "ASCII":
            arr = np.array(text.split(), dtype=DTYPES[da.get("DataType")])
        else:
            data = base64.b64decode(text)
            if enc == "GZipBase64Binary":
                data = zlib.decompress(data)
            dtype = np.dtype(DTYPES[da.get("DataType")])
            if da.get("Endian") == "BigEndian":
                dtype = dtype.newbyteorder(">")
            arr = np.frombuffer(data, dtype=dtype)
        order = "F" if da.get("ArrayIndexingOrder") == "ColumnMajorOrder" else "C"
        arrays.append(arr.reshape(dims, order=order))
    return arrays


def build(folder: Path) -> dict:
    hemis = {}
    for side in ("left", "right"):
        verts, faces = read_gifti(folder / f"pial_{side}.gii.gz")
        sulc = read_gifti(folder / f"sulc_{side}.gii.gz")[0]
        hemis[side] = (verts.astype(float), faces.astype(int), sulc.astype(float))
    allv = np.vstack([h[0] for h in hemis.values()])
    lo, hi = allv.min(axis=0), allv.max(axis=0)
    centre, half = (lo + hi) / 2, (hi - lo) / 2
    scale = HALF_EXTENT_MM / half
    out = {"source": "fsaverage5 pial surface (FreeSurfer), via nilearn", "frame": "+x right, +y nose, +z up, mm"}
    fitted = {}
    for side, (v, f, s) in hemis.items():
        v = (v - centre) * scale + [0, 0, CENTRE_Z_MM]
        fitted[side] = (v, f, s)
    r_max = max(np.linalg.norm(v, axis=1).max() for v, _, _ in fitted.values())
    shrink = min(1.0, (INNER_RADIUS_MM - 1) / r_max)
    for side, (v, f, s) in fitted.items():
        v = v * shrink
        s = np.clip((s - np.percentile(s, 2)) / (np.percentile(s, 98) - np.percentile(s, 2)), 0, 1)
        out[side] = {"vertices": np.round(v, 1).ravel().tolist(), "faces": f.ravel().tolist(),
                     "sulc": np.round(s, 2).tolist()}
    return out


def load(path: Path = OUT) -> np.ndarray:
    """All cortex vertices, left then right, (N, 3) mm in the head frame."""
    data = json.loads(path.read_text())
    return np.vstack([np.array(data[s]["vertices"]).reshape(-1, 3) for s in ("left", "right")])


if __name__ == "__main__":
    brain = build(Path(sys.argv[1]))
    OUT.write_text(json.dumps(brain, separators=(",", ":")))
    v = np.vstack([np.array(brain[s]["vertices"]).reshape(-1, 3) for s in ("left", "right")])
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB), {len(v)} vertices, "
          f"x {v[:, 0].min():.0f}..{v[:, 0].max():.0f}, y {v[:, 1].min():.0f}..{v[:, 1].max():.0f}, "
          f"z {v[:, 2].min():.0f}..{v[:, 2].max():.0f}, max radius {np.linalg.norm(v, axis=1).max():.0f}")
