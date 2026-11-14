"""Precompute the cortex views for the map image: `python -m lucid.physics.precompute_cortex` (from agent/).

The dashboard's Scan tab draws the FreeSurfer fsaverage6 cortex with three.js (lib/brain-scene.ts): orthographic,
from above, nose up, patient's left on screen left, and the medic can orbit it. This bakes three views once, without
a browser: from above, and from the patient's left and right sides (crown up, each hemisphere alone), in the brain's
true proportions. It decodes public/models/fsaverage6.bin.gz (lib/brain-model.ts), scales it to true millimetres,
turns it into view space as the scene's rotated group does, rasterises the front faces with a z-buffer at 4 x 4
samples per pixel, runs the fragment shader up to `vec3 cortex` (lights on view-space normals of the true shape;
`vPosition` and `projectCortexMap(vHead)` on the dashboard's own coordinates, so the heat stays on the same anatomy)
on every sample, and box-filters the samples into pixels. data/cortex_views.npz then holds, per view and pixel: the lit cortex
colour, the map coordinate, the heat opacity and the coverage (anti-aliased edge). render.py adds the scan heat.
"""
from __future__ import annotations

import gzip
import time
import zipfile

import numpy as np

from . import DATA_DIR
from .render import CORTEX as CORTEX_PATH
from .render import VIEWS

REPO = DATA_DIR.parents[1]
MODEL = REPO / "public" / "models" / "fsaverage6.bin.gz"
SS = 4  # samples per pixel along each axis
# The shipped mesh is in the dashboard's display units. The offline export (tools/brain-export/export_fs6.py) scaled the
# real fsaverage6 pial surface per axis to fit the scan map's head ellipse and toDisplayPositions scales again per axis,
# so neither display units nor displayToHead's head frame keep the brain's proportions (wide to long from above: 0.735
# and 0.895; the real surface: 0.796). The views are drawn on the real extents of the source surface: fsaverage6 pial,
# both hemispheres, as Nilearn ships it (width, length, height in mm).
TRUE_EXTENT_MM = np.array([138.66, 174.21, 127.66])
BASE = np.array([0.58, 0.64, 0.68])
RX, RY = 0.676, 0.92  # lib/brain-heat.ts
RIM_HEAT_BAND, RIM_SAMPLE_BAND = np.radians(12), np.radians(10)


def decode(raw: bytes) -> list[tuple[np.ndarray, np.ndarray, np.ndarray]]:
    """lib/brain-model.ts decodeCortex: [(positions n x 3, faces m x 3, cavity n)] for the left and right hemispheres."""
    assert raw[:8] == b"LUCIDC01", "invalid cortex model"
    off, out = 8, []
    for _ in range(2):
        count, tris = (int(v) for v in np.frombuffer(raw, "<u4", 2, off))
        low, extent = np.frombuffer(raw, "<f4", 6, off + 8).reshape(2, 3).astype(np.float64)
        off += 32
        q = np.frombuffer(raw, "<u2", count * 3, off).reshape(-1, 3)
        pos = (low + q / 65535 * extent).astype(np.float32)
        off += count * 6
        faces = np.frombuffer(raw, "<u2", tris * 3, off).reshape(-1, 3).astype(np.int64)
        off += tris * 6
        cavity = np.frombuffer(raw, "u1", count, off) / 255
        off = -(-(off + count) // 4) * 4
        out.append((pos, faces, cavity.astype(np.float32)))
    assert off == len(raw), "unexpected cortex payload size"
    return out


def normals(pos: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """lib/brain-geometry.ts surfaceNormals: area-weighted vertex normals."""
    a, b, c = (pos[faces[:, i]].astype(np.float64) for i in range(3))
    fn = np.cross(b - a, c - a)
    n = np.zeros(pos.shape)
    for i in range(3):
        np.add.at(n, faces[:, i], fn)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def shade(n: np.ndarray, sulc: np.ndarray, p: np.ndarray) -> np.ndarray:
    """The fragment shader's main() up to `vec3 cortex`: n unit normals, sulc, p scene positions."""
    key = np.array([-0.6, 0.7, 1.1]) / np.linalg.norm([-0.6, 0.7, 1.1])
    rim = np.array([0.8, -0.4, 0.5]) / np.linalg.norm([0.8, -0.4, 0.5])
    half = (key + [0, 0, 1]) / np.linalg.norm(key + [0, 0, 1])
    nk = np.maximum(n @ key, 0)
    light = 0.36 + 0.66 * nk + 0.06 * np.maximum(n @ rim, 0)
    groove = smoothstep(0.04, 0.72, sulc)
    ao = 1 - groove**1.15 * 0.88
    crown = 1 + 0.09 * (1 - sulc) * nk
    sheen = 0.045 * np.maximum(n @ half, 0) ** 6
    midline = 0.014 * np.sin(p[:, 1] * 7 + 0.4) + 0.003 * np.sin(p[:, 1] * 19)
    medial = 1 - smoothstep(0.006, 0.035, np.abs(p[:, 0] - midline))
    flank = 0.45 + 0.55 * smoothstep(-0.15, 0.75, n[:, 2])
    return (BASE * (light * crown)[:, None] + sheen[:, None]) * (ao * flank * (1 - medial * 0.9))[:, None]


def project(p: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """lib/brain-heat.ts displayToHead then cortexProjectionGLSL: (map uv, heat opacity) for scene positions."""
    hx, hy, hz = p[:, 0] / (RX * 0.97 / 66.2), p[:, 1] / (RY * 0.97 / 74), p[:, 2] / 0.011 + 8
    angle = np.arctan2(hx, hy)
    offset = np.arctan2(np.hypot(hx / 66.2, hy / 74), (hz - 8) / 58) - np.pi / 2
    h = RIM_SAMPLE_BAND
    mapped = np.where(offset <= -h, offset, np.where(offset >= h, 0, -((h - offset) ** 2) / (4 * h)))
    radius = 0.97 * (1 + mapped / (np.pi / 2))
    d = np.stack([np.sin(angle), -np.cos(angle)], -1)
    uv = 0.5 + 0.5 * d * (radius / np.hypot(d[:, 0] / RX, d[:, 1] / RY))[:, None]
    return uv, 1 - smoothstep(0, RIM_HEAT_BAND, offset)


def rasterise(pos: np.ndarray, faces: np.ndarray, x0: float, y1: float, w: int, h: int, step: float):
    """Front faces through a z-buffer on a w x h sample grid (sample (r, c) at x0 + (c + .5) step, y1 - (r + .5) step).

    Returns the winning face per sample (-1 for none) and its barycentrics.
    """
    a, b, c = (pos[faces[:, i]].astype(np.float64) for i in range(3))
    area = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
    front = area > 1e-14  # three.js FrontSide: counter-clockwise as seen from the camera at +z
    a, b, c, area, ids = a[front], b[front], c[front], area[front], np.flatnonzero(front)
    xs, ys = np.stack([a[:, 0], b[:, 0], c[:, 0]]), np.stack([a[:, 1], b[:, 1], c[:, 1]])
    c0 = np.clip(np.ceil((xs.min(0) - x0) / step - 0.5), 0, w).astype(int)
    c1 = np.clip(np.floor((xs.max(0) - x0) / step - 0.5), -1, w - 1).astype(int)
    r0 = np.clip(np.ceil((y1 - ys.max(0)) / step - 0.5), 0, h).astype(int)
    r1 = np.clip(np.floor((y1 - ys.min(0)) / step - 0.5), -1, h - 1).astype(int)
    bw, bh = c1 - c0 + 1, r1 - r0 + 1
    keep = (bw > 0) & (bh > 0)
    side = np.maximum(bw, bh)
    order = np.flatnonzero(keep)[np.argsort(side[keep], kind="stable")]
    zbuf = np.full(w * h, -np.inf)
    win = np.full(w * h, -1, np.int64)
    boxes = side[order] ** 2
    i = 0
    while i < len(order):
        # Chunks of similar box size, at most about a million candidate samples each.
        fits = boxes[i:] * np.arange(1, len(order) - i + 1) <= 1_000_000
        j = i + max(1, int(np.argmin(fits)) if not fits.all() else len(fits))
        t = order[i:j]
        W, H = bw[t].max(), bh[t].max()
        gr, gc = np.mgrid[0:H, 0:W]
        rr = r0[t, None, None] + gr
        cc = c0[t, None, None] + gc
        px, py = x0 + (cc + 0.5) * step, y1 - (rr + 0.5) * step
        ax, ay = a[t, 0, None, None], a[t, 1, None, None]
        bx, by = b[t, 0, None, None], b[t, 1, None, None]
        cx, cy = c[t, 0, None, None], c[t, 1, None, None]
        l1 = ((px - ax) * (cy - ay) - (py - ay) * (cx - ax)) / area[t, None, None]
        l2 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / area[t, None, None]
        l0 = 1 - l1 - l2
        inside = (l0 >= 0) & (l1 >= 0) & (l2 >= 0) & (rr <= r1[t, None, None]) & (cc <= c1[t, None, None])
        z = l0 * a[t, 2, None, None] + l1 * b[t, 2, None, None] + l2 * c[t, 2, None, None]
        idx, z, tri = (rr * w + cc)[inside], z[inside], np.broadcast_to(ids[t, None, None], inside.shape)[inside]
        # Nearest (largest z) per sample within the chunk, then against the buffer.
        o = np.lexsort((-z, idx))
        idx, z, tri = idx[o], z[o], tri[o]
        first = np.r_[True, idx[1:] != idx[:-1]]
        idx, z, tri = idx[first], z[first], tri[first]
        better = z > zbuf[idx]
        zbuf[idx[better]], win[idx[better]] = z[better], tri[better]
        i = j
    return win


def load() -> dict[str, tuple[np.ndarray, ...]]:
    """Each hemisphere: display positions, true-mm positions, normals of the true shape, cavity, faces."""
    hemis = decode(gzip.decompress(MODEL.read_bytes()))
    display = np.vstack([p for p, _, _ in hemis]).astype(np.float64)
    mm = TRUE_EXTENT_MM / np.ptp(display, axis=0)  # millimetres per display unit, per axis
    return {side: (p.astype(np.float64), p * mm, normals(p * mm, f), s, f) for side, (p, f, s) in zip(("left", "right"), hemis)}


def merge(parts) -> tuple[np.ndarray, ...]:
    """Several hemispheres as one mesh."""
    offsets = np.cumsum([0] + [len(part[0]) for part in parts])
    return (*(np.concatenate([part[i] for part in parts]) for i in range(4)), np.concatenate([part[4] + o for part, o in zip(parts, offsets)]))


def bake(mesh, rotation: np.ndarray, scale: float) -> dict[str, np.ndarray]:
    """One view: the true-mm mesh turned by `rotation` (object to view space; camera at +z, up +y), at `scale` px per mm."""
    pos, mm, nrm, sulc, faces = mesh
    view, vnrm = mm @ rotation.T, nrm @ rotation.T  # modelViewMatrix, normalMatrix

    # Pixel box around the silhouette, a few pixels of margin.
    lo, hi = view[:, :2].min(0), view[:, :2].max(0)
    left, right = int(np.floor(lo[0] * scale)) - 4, int(np.ceil(hi[0] * scale)) + 4
    bottom, top = int(np.floor(lo[1] * scale)) - 4, int(np.ceil(hi[1] * scale)) + 4
    x0, y1, w, h = left / scale, top / scale, right - left, top - bottom
    W, H, step = w * SS, h * SS, 1 / (scale * SS)
    win = rasterise(view, faces, x0, y1, W, H, step)

    # Shade every covered sample (in chunks, to bound memory) and box-filter into pixels: coverage, and the mean of
    # each attribute (cortex rgb, map uv, heat opacity) over the covered samples.
    hit = np.flatnonzero(win >= 0)
    sums = np.zeros((6, w * h))
    count = np.zeros(w * h)
    for part in np.array_split(hit, max(1, len(hit) // 500_000)):
        f = faces[win[part]]
        rr, cc = part // W, part % W
        px, py = x0 + (cc + 0.5) * step, y1 - (rr + 0.5) * step
        a, b, c = (view[f[:, i]] for i in range(3))
        area = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
        l1 = ((px - a[:, 0]) * (c[:, 1] - a[:, 1]) - (py - a[:, 1]) * (c[:, 0] - a[:, 0])) / area
        l2 = ((b[:, 0] - a[:, 0]) * (py - a[:, 1]) - (b[:, 1] - a[:, 1]) * (px - a[:, 0])) / area
        l = np.stack([1 - l1 - l2, l1, l2], -1)[..., None]
        p = (l * pos[f]).sum(1)  # vPosition, and through displayToHead vHead: the dashboard's object space
        n = (l * vnrm[f]).sum(1)  # vNormal: view space
        n /= np.linalg.norm(n, axis=1, keepdims=True)
        uv, opacity = project(p)
        attrs = np.c_[shade(n, (l[..., 0] * sulc[f]).sum(1), p), uv, opacity]
        pix = (rr // SS) * w + cc // SS
        count += np.bincount(pix, minlength=w * h)
        for k in range(6):
            sums[k] += np.bincount(pix, attrs[:, k], w * h)
    mean = (sums / np.maximum(count, 1)).T.reshape(h, w, 6)
    cover = (count / SS**2).reshape(h, w)
    on = (cover > 0)[..., None]
    return {
        "cortex": np.where(on, np.round(mean[..., :3] * 255), 0).clip(0, 255).astype(np.uint8),
        "uv": np.where(on, mean[..., 3:5], 0).astype(np.float16),
        "opacity": np.where(on[..., 0], np.round(mean[..., 5] * 255), 0).astype(np.uint8),
        "alpha": np.round(cover * 255).astype(np.uint8),
        "frame": np.array([x0, y1, scale], np.float64),  # pixel (r, c) centre in view mm: x0 + (c + .5) / scale, y1 - (r + .5) / scale
    }


def main() -> None:
    t0 = time.perf_counter()
    mesh = load()
    arrays = {
        f"{name}_{key}": arr
        for name, (rotation, scale, sides) in VIEWS.items()
        for key, arr in bake(merge([mesh[side] for side in sides]), np.array(rotation, float), scale).items()
    }
    # np.savez_compressed, with fixed zip timestamps so a rebuild gives the same bytes.
    with zipfile.ZipFile(CORTEX_PATH, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name, arr in arrays.items():
            info = zipfile.ZipInfo(f"{name}.npy", (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            with z.open(info, "w") as fh:
                np.lib.format.write_array(fh, arr, allow_pickle=False)
    sizes = ", ".join(f"{name} {arrays[name + '_alpha'].shape[1]} x {arrays[name + '_alpha'].shape[0]}" for name in VIEWS)
    print(f"wrote {CORTEX_PATH} ({sizes} px, {CORTEX_PATH.stat().st_size / 1e6:.2f} MB) in {time.perf_counter() - t0:.1f} s")


if __name__ == "__main__":
    main()
