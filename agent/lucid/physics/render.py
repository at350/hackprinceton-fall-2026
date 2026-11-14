"""The bleed map as a PNG, for the pre-alert text message.

The picture the medic has on the dashboard's Scan tab: the verdict and its numbers, and under them the 3D cortex
(lib/brain-scene.ts) with the scan heat on it, seen from above (nose up, patient's left on screen left) and, as the
medic sees it when orbiting, from the patient's left and right sides. A temporal bleed sits on the side wall, a thin
rim from above. The views are baked once by precompute_cortex.py (data/cortex_views.npz); here the scan grid is
sampled and tinted per pixel exactly as the fragment shader does it. Pillow and numpy only, safe in a worker thread.
"""
from __future__ import annotations

import io
import re
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .geometry import HEAD_RX, HEAD_RY

REPO = Path(__file__).resolve().parents[3]
CORTEX = Path(__file__).resolve().parents[2] / "data" / "cortex_views.npz"  # precompute_cortex.py
FONTS = REPO / "app" / "fonts"

# app/globals.css
BG, TEXT, MUTED, BLEED, UNCERTAIN, SAFE = (0x0D, 0x0F, 0x11), (0xED, 0xEE, 0xF0), (0xAC, 0xB5, 0xC0), (0xFF, 0x94, 0x79), (0xFF, 0xC5, 0x3D), (0x93, 0xB1, 0xFF)
HEAT = np.array([[int(h[i : i + 2], 16) for i in (1, 3, 5)] for h in ("#39170f", "#501306", "#601b0b", "#702818", "#893826", "#b14932", "#ff5a36")], float)
BASE = np.array([0.58, 0.64, 0.68])  # the cortex albedo in the fragment shader
CAPTION = "Screening aid, not a diagnosis. Confirm with CT."
# The views precompute_cortex.py bakes: the rotation from object to view space (camera at +z looking down -z, up +y;
# object +x right ear, +y nose, +z crown), the size in px per scene unit at 1080 px wide, and which hemispheres are
# drawn. Sides: crown up, each hemisphere alone so a side view never shows the other one past the poles; from the
# left the front is on screen left, from the right on screen right. The two sides share a scale so they compare.
VIEWS = {
    "top": (((1, 0, 0), (0, 1, 0), (0, 0, 1)), 300, ("left", "right")),
    "left": (((0, -1, 0), (0, 0, 1), (-1, 0, 0)), 256, ("left",)),
    "right": (((0, 1, 0), (0, 0, 1), (1, 0, 0)), 256, ("right",)),
}
# components/icons.tsx: Phosphor warning, question and shield-check (light), on their 256 grid.
ICONS = {
    "alert": "M235.07 189.09L147.61 37.22a22.75 22.75 0 0 0-39.22 0L20.93 189.09a21.53 21.53 0 0 0 0 21.72A22.35 22.35 0 0 0 40.55 222h174.9a22.35 22.35 0 0 0 19.6-11.19a21.53 21.53 0 0 0 .02-21.72m-10.41 15.71a10.46 10.46 0 0 1-9.21 5.2H40.55a10.46 10.46 0 0 1-9.21-5.2a9.51 9.51 0 0 1 0-9.72l87.45-151.87a10.75 10.75 0 0 1 18.42 0l87.46 151.87a9.51 9.51 0 0 1-.01 9.72M122 144v-40a6 6 0 0 1 12 0v40a6 6 0 0 1-12 0m16 36a10 10 0 1 1-10-10a10 10 0 0 1 10 10",
    "question": "M138 180a10 10 0 1 1-10-10a10 10 0 0 1 10 10M128 74c-21 0-38 15.25-38 34v4a6 6 0 0 0 12 0v-4c0-12.13 11.66-22 26-22s26 9.87 26 22s-11.66 22-26 22a6 6 0 0 0-6 6v8a6 6 0 0 0 12 0v-2.42c18.11-2.58 32-16.66 32-33.58c0-18.75-17-34-38-34m102 54A102 102 0 1 1 128 26a102.12 102.12 0 0 1 102 102m-12 0a90 90 0 1 0-90 90a90.1 90.1 0 0 0 90-90",
    "shield": "M208 42H48a14 14 0 0 0-14 14v56c0 51.94 25.12 83.4 46.2 100.64c22.73 18.6 45.27 24.89 46.22 25.15a6 6 0 0 0 3.16 0c.95-.26 23.49-6.55 46.22-25.15C196.88 195.4 222 163.94 222 112V56a14 14 0 0 0-14-14m2 70c0 37.76-13.94 68.39-41.44 91.06A131.2 131.2 0 0 1 128 225.72a131 131 0 0 1-40.56-22.66C59.94 180.39 46 149.76 46 112V56a2 2 0 0 1 2-2h160a2 2 0 0 1 2 2Zm-37.76-12.24a6 6 0 0 1 0 8.48l-56 56a6 6 0 0 1-8.48 0l-24-24a6 6 0 0 1 8.48-8.48L112 151.51l51.76-51.75a6 6 0 0 1 8.48 0",
}
# components/ui.tsx SCAN_STATUS: label, colour, icon.
VERDICT = {"bleed": ("Bleed likely", BLEED, "alert"), "clear": ("No bleed seen", SAFE, "shield"), "uncertain": ("Uncertain, re-scan", UNCERTAIN, "question")}


def _heat(v: np.ndarray) -> np.ndarray:
    """heatRGB: value 0-1 along the heat stops."""
    x = np.clip(v, 0, 1) * (len(HEAT) - 1)
    i = np.minimum(len(HEAT) - 2, np.floor(x)).astype(int)
    return HEAT[i] + (HEAT[i + 1] - HEAT[i]) * (x - i)[..., None]


# The shader's heat ramp: a 256-texel byte texture of heatRGB, linearly filtered.
RAMP = np.trunc(_heat(np.arange(256) / 255)) / 255


def _ramp(t: np.ndarray) -> np.ndarray:
    x = np.clip(t * 256 - 0.5, 0, 255)
    i = np.minimum(254, np.floor(x)).astype(int)
    return RAMP[i] + (RAMP[i + 1] - RAMP[i]) * (x - i)[..., None]


@lru_cache(maxsize=1)
def _cortex() -> dict | None:
    """The baked views (precompute_cortex.py), only the covered pixels kept. None if the file is missing or unreadable."""
    try:
        views = {}
        with np.load(CORTEX) as d:
            for name in VIEWS:
                alpha = d[f"{name}_alpha"] / 255
                on = alpha > 0
                views[name] = {
                    "shape": alpha.shape, "on": on, "alpha": alpha[on], "frame": d[f"{name}_frame"],
                    "cortex": d[f"{name}_cortex"][on] / 255, "uv": d[f"{name}_uv"][on].astype(np.float64), "opacity": d[f"{name}_opacity"][on] / 255,
                }
        return views
    except Exception:  # noqa: BLE001 - a broken cache must not stop the hand-off: map_png falls back to the outline
        return None


def _texture(grid) -> np.ndarray:
    """lib/brain-heat.ts mapTextureData as floats: likelihood, coverage and the in-head footprint, byte-quantised."""
    v = np.nan_to_num(np.asarray(grid, float), nan=0.0, posinf=0.0, neginf=0.0)
    if v.ndim != 2 or v.shape[0] != v.shape[1] or v.size == 0:
        v = np.zeros((1, 1))
    v, n = np.clip(v, 0, 1), len(v)
    ax = np.linspace(-1, 1, n) if n > 1 else np.zeros(1)
    y, x = np.meshgrid(ax, ax, indexing="ij")
    inside = np.hypot(x / HEAD_RX, y / HEAD_RY) <= 0.97
    return np.stack([np.round(v * 255), np.round(np.minimum(1, v / 0.06) * 255), inside * 255.0], -1) / 255


def _sample(tex: np.ndarray, uv: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """The shader's sampleMap: bilinear at texel centres (u along columns, v along rows), normalised by the footprint."""
    n = len(tex)
    col, row = uv[:, 0] * (n - 1), uv[:, 1] * (n - 1)
    c0, r0 = np.clip(np.floor(col), 0, n - 1).astype(int), np.clip(np.floor(row), 0, n - 1).astype(int)
    c1, r1 = np.minimum(c0 + 1, n - 1), np.minimum(r0 + 1, n - 1)
    fc, fr = np.clip(col - c0, 0, 1)[:, None], np.clip(row - r0, 0, 1)[:, None]
    s = (tex[r0, c0] * (1 - fc) + tex[r0, c1] * fc) * (1 - fr) + (tex[r1, c0] * (1 - fc) + tex[r1, c1] * fc) * fr
    a = s[:, 2:3]
    vc = np.where(a > 0.001, np.clip(s[:, :2] / np.maximum(a, 1e-9), 0, 1), 0)
    return vc[:, 0], vc[:, 1]


def _smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def _brain_layer(tex: np.ndarray, view: dict, scale: float) -> tuple[Image.Image, tuple[float, float]]:
    """One baked view with the heat on it, as RGBA over transparent, and the scene origin's pixel in it."""
    value, coverage = _sample(tex, view["uv"])
    # The fragment shader's tissue(), fully revealed.
    alpha = (_smoothstep(0.2, 0.65, value) * 0.94 * view["opacity"])[:, None]
    heat = _ramp(np.clip((value - 0.15) / 0.75, 0, 1))
    cortex = view["cortex"]
    out = cortex * (0.2 + 0.8 * coverage)[:, None] * (1 - alpha) + heat * (cortex / BASE) * alpha
    img = np.zeros((*view["shape"], 4), np.uint8)
    img[view["on"]] = np.round(np.c_[np.clip(out, 0, 1), view["alpha"]] * 255)
    layer = Image.fromarray(img, "RGBA")
    x0, y1, baked = view["frame"]
    k = scale / baked
    if abs(k - 1) > 1e-6:
        layer = layer.resize((max(1, round(layer.width * k)), max(1, round(layer.height * k))), Image.LANCZOS)
    return layer, (-x0 * scale, y1 * scale)


def _plain_layer(grid, scale: float) -> tuple[Image.Image, tuple[float, float]]:
    """Without the baked cortex: the scan grid itself as heat inside the head outline, same placement and orientation."""
    size = max(1, round(2 * scale))
    v = np.asarray(Image.fromarray(_texture(grid)[..., 0].astype(np.float32), "F").resize((size, size), Image.BILINEAR), float)
    yy, xx = np.mgrid[-1 : 1 : size * 1j, -1 : 1 : size * 1j]
    inside = np.clip((0.97 - np.hypot(xx / HEAD_RX, yy / HEAD_RY)) * scale * 0.7 + 0.5, 0, 1)  # about a pixel of edge
    a = (_smoothstep(0.2, 0.65, v) * 0.94)[..., None]
    rgb = np.full((size, size, 3), 0x17, float) * (1 - a) + _heat((v - 0.15) / 0.75) * a
    return Image.fromarray(np.dstack([rgb, inside * 255]).clip(0, 255).astype(np.uint8), "RGBA"), (size / 2, size / 2)


def _subpaths(d: str) -> list[list[tuple[float, float]]]:
    """An SVG path (M L H V C S A Z, absolute and relative) as polygons; curves and arcs flattened."""
    tokens = re.findall(r"[MLHVCSAZmlhvcsaz]|-?(?:\d+\.?\d*|\.\d+)", d)
    paths: list[list[tuple[float, float]]] = []
    x = y = sx = sy = 0.0
    ctrl, cmd, i = None, "", 0

    def num(n: int) -> list[float]:
        nonlocal i
        vals = [float(t) for t in tokens[i : i + n]]
        i += n
        return vals

    while i < len(tokens):
        if tokens[i].isalpha():
            cmd, i = tokens[i], i + 1
        rel, c = cmd.islower(), cmd.upper()
        ox, oy = (x, y) if rel else (0.0, 0.0)
        if c == "Z":
            x, y, ctrl = sx, sy, None
            continue
        if c == "M":
            dx, dy = num(2)
            x, y = sx, sy = ox + dx, oy + dy
            paths.append([(x, y)])
            cmd = "l" if rel else "L"  # later pairs are line-tos
            ctrl = None
            continue
        pts = paths[-1]
        if c in "LHV":
            if c == "L":
                dx, dy = num(2)
                x, y = ox + dx, oy + dy
            elif c == "H":
                x = ox + num(1)[0]
            else:
                y = oy + num(1)[0]
            pts.append((x, y))
            ctrl = None
        elif c in "CS":
            if c == "C":
                x1, y1, x2, y2, ex, ey = num(6)
                p1 = (ox + x1, oy + y1)
            else:
                x2, y2, ex, ey = num(4)
                p1 = (2 * x - ctrl[0], 2 * y - ctrl[1]) if ctrl else (x, y)
            p2, p3 = (ox + x2, oy + y2), (ox + ex, oy + ey)
            for t in np.linspace(0, 1, 13)[1:]:
                u = 1 - t
                pts.append(tuple(u**3 * a + 3 * u * u * t * b + 3 * u * t * t * e + t**3 * f for a, b, e, f in zip((x, y), p1, p2, p3)))
            (x, y), ctrl = p3, p2
        elif c == "A":
            rx, ry, phi, large, sweep, ex, ey = num(7)
            x2, y2 = ox + ex, oy + ey
            pts.extend(_arc(x, y, abs(rx), abs(ry), np.radians(phi), bool(large), bool(sweep), x2, y2))
            x, y, ctrl = x2, y2, None
    return paths


def _arc(x1, y1, rx, ry, phi, large, sweep, x2, y2, n=24):
    """SVG elliptical arc, endpoint to centre parameterisation (SVG 1.1 F.6.5), as n points after the start."""
    if rx == 0 or ry == 0:
        return [(x2, y2)]
    c, s = np.cos(phi), np.sin(phi)
    dx, dy = (x1 - x2) / 2, (y1 - y2) / 2
    xp, yp = c * dx + s * dy, -s * dx + c * dy
    lam = xp**2 / rx**2 + yp**2 / ry**2
    if lam > 1:
        rx, ry = rx * np.sqrt(lam), ry * np.sqrt(lam)
    k = np.sqrt(max(0.0, (rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp) / (rx * rx * yp * yp + ry * ry * xp * xp)))
    k = -k if large == sweep else k
    cxp, cyp = k * rx * yp / ry, -k * ry * xp / rx
    cx, cy = c * cxp - s * cyp + (x1 + x2) / 2, s * cxp + c * cyp + (y1 + y2) / 2
    t1 = np.arctan2((yp - cyp) / ry, (xp - cxp) / rx)
    dt = (np.arctan2((-yp - cyp) / ry, (-xp - cxp) / rx) - t1) % (2 * np.pi)
    if not sweep and dt > 0:
        dt -= 2 * np.pi
    t = t1 + dt * np.arange(1, n + 1) / n
    return list(zip(cx + rx * np.cos(t) * c - ry * np.sin(t) * s, cy + rx * np.cos(t) * s + ry * np.sin(t) * c))


def _icon(name: str, px: int) -> Image.Image:
    """A Phosphor icon as a px x px coverage mask (even-odd fill, 4x supersampled)."""
    ss = px * 4
    mask = np.zeros((ss, ss), bool)
    for poly in _subpaths(ICONS[name]):
        if len(poly) > 2:
            layer = Image.new("1", (ss, ss))
            ImageDraw.Draw(layer).polygon([(u * ss / 256, v * ss / 256) for u, v in poly], fill=1)
            mask ^= np.asarray(layer)
    return Image.fromarray((mask * 255).astype(np.uint8)).resize((px, px), Image.BOX)


@lru_cache(maxsize=16)
def _font(weight: int, px: int) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(str(FONTS / f"Switzer-{weight}.woff2"), px)
    except OSError:
        return ImageFont.load_default(px)


def _text(draw: ImageDraw.ImageDraw, xy: tuple[float, float], text: str, weight: int, px: int, fill, tracking: float = 0, anchor: str = "l") -> float:
    """One line on the baseline `xy[1]` with CSS-style letter-spacing (`tracking` in em). `anchor`: l, m or r. Returns the right edge."""
    font, gap = _font(weight, px), tracking * px
    width = sum(font.getlength(c) + gap for c in text) - gap
    x = xy[0] - {"l": 0, "m": width / 2, "r": width}[anchor]
    for c in text:
        draw.text((x, xy[1]), c, font=font, fill=fill, anchor="ls")
        x += font.getlength(c) + gap
    return x - gap


def map_png(grid, result: dict | None = None, width_px: int = 1080) -> bytes:
    """A map grid (e.g. 64x64, values 0-1) as PNG bytes: the result as the dashboard's Scan tab states it, and the cortex with the heat.

    `result` is the scan as the medic approved it: `status`, `region`, `volume_ml`, `confidence`, and optionally `patient_id`.
    """
    w, k = width_px, width_px / 1080
    h = round(w * 1.25)
    out = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(out)
    r = result or {}
    x = 72 * k

    # The verdict with its icon, and the numbers behind it on one line (components/ScanTab.tsx Verdict and Summary).
    label, colour, icon = VERDICT.get(r.get("status"), ("Screening map", TEXT, None))
    px, base = round(104 * k), 168 * k
    tx = x
    if icon:  # 36 px beside 56 px type, 12 px apart, centred on the line box
        ascent, descent = _font(600, px).getmetrics()
        size = round(px * 36 / 56)
        top = round(base - (ascent - descent) / 2 - size / 2)
        out.paste(colour, (round(x), top, round(x) + size, top + size), _icon(icon, size))
        tx = x + size + px * 12 / 56
    _text(d, (tx - 0.04 * px, base), label, 600, px, colour, tracking=-0.045)
    parts = [str(r["region"])] if r.get("region") and r.get("status") != "clear" else []
    try:
        if r.get("volume_ml") and float(r["volume_ml"]) > 0:
            parts.append(f"about {float(r['volume_ml']):g} mL")
        if r.get("confidence") is not None:
            parts.append(f"fit {float(r['confidence']):.2f}")
    except (TypeError, ValueError):
        pass
    px, cx, base = round(38 * k), x, 236 * k
    for i, p in enumerate(parts):
        if i:  # a small muted dot at half opacity, half an em either side
            dot, mid = 0.1 * px, base - 0.34 * px
            d.ellipse([cx + px / 2, mid - dot, cx + px / 2 + 2 * dot, mid + dot], fill=tuple(round((m + b) / 2) for m, b in zip(MUTED, BG)))
            cx += px + 2 * dot
        cx = _text(d, (cx, base), p, 400, px, TEXT, tracking=-0.02)

    # From above, centred, with L and R beside it where the Scan tab puts them (x = -0.98 and 0.98, mid-height);
    # under it the left and right sides, each named, spaced evenly between the header and the caption.
    try:
        views, tex = _cortex(), _texture(grid)
        brains = views and [(_brain_layer(tex, views[name], VIEWS[name][1] * k), at) for name, at in (
            ("top", (w / 2, 552 * k)), ("left", (w / 2 - 248 * k, 1020 * k)), ("right", (w / 2 + 248 * k, 1020 * k)))]
    except Exception:  # noqa: BLE001 - an unexpected grid must not stop the image
        brains = None
    small = dict(weight=500, px=round(24 * k), fill=MUTED, anchor="m")
    if brains:
        for (layer, origin), at in brains:
            out.paste(layer, (round(at[0] - origin[0]), round(at[1] - origin[1])), layer)
        scale, (cx, cy) = VIEWS["top"][1] * k, brains[0][1]
        _text(d, (cx - 0.98 * scale, cy + 8 * k), "L", **small)
        _text(d, (cx + 0.98 * scale, cy + 8 * k), "R", **small)
        _text(d, (w / 2 - 248 * k, 1226 * k), "Left side", **small)
        _text(d, (w / 2 + 248 * k, 1226 * k), "Right side", **small)
    else:  # no baked cortex: the heat inside the head outline, from above only
        scale, (cx, cy) = 470 * k, (w / 2, 762 * k)
        layer, origin = _plain_layer(grid, scale)
        out.paste(layer, (round(cx - origin[0]), round(cy - origin[1])), layer)
        _text(d, (cx - 0.98 * scale, cy + 0.02 * scale), "L", **(small | {"px": round(0.06 * scale)}))
        _text(d, (cx + 0.98 * scale, cy + 0.02 * scale), "R", **(small | {"px": round(0.06 * scale)}))

    foot = " ".join(filter(None, [f"Patient {r['patient_id']}." if r.get("patient_id") else "", CAPTION]))
    _text(d, (x, h - 64 * k), foot, 400, round(28 * k), MUTED)

    buf = io.BytesIO()
    out.save(buf, format="PNG")
    return buf.getvalue()
