"""The bleed map as a PNG, for the pre-alert text message.

The picture the medic has on the dashboard's 2D brain view (lib/brain.ts): the
brain render seen from above, nose up, patient's left on screen left, lit and
with the heat on top, clipped to the brain. Under it, the approved result in the
dashboard's type (Switzer) and colours. Drawn with Pillow and numpy only, so it
is safe in a worker thread.
"""
from __future__ import annotations

import io
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .geometry import HEAD_RX, HEAD_RY

REPO = Path(__file__).resolve().parents[3]
BRAIN = REPO / "public" / "renders" / "brain-top.png"
FONTS = REPO / "app" / "fonts"

# app/globals.css and components/ui.tsx
BG, TEXT, MUTED, LINE = (0x0D, 0x0F, 0x11), (0xED, 0xEE, 0xF0), (0xAC, 0xB5, 0xC0), (0x22, 0x24, 0x26)
HEAT = np.array([[int(h[i : i + 2], 16) for i in (1, 3, 5)] for h in ("#39170f", "#501306", "#601b0b", "#702818", "#893826", "#b14932", "#ff5a36")], float)
IMG = (0.92 * 0.97) / 0.932  # lib/brain.ts: the render drawn over [-IMG, IMG] puts its silhouette on the head outline
CAPTION = "Screening aid, not a diagnosis. Confirm with CT."
VERDICT = {"bleed": "Bleed likely", "clear": "No bleed seen", "uncertain": "Uncertain, re-scan"}


def _heat(v: np.ndarray) -> np.ndarray:
    """heatRGB: value 0-1 along the heat stops."""
    x = np.clip(v, 0, 1) * (len(HEAT) - 1)
    i = np.minimum(len(HEAT) - 2, np.floor(x)).astype(int)
    return HEAT[i] + (HEAT[i + 1] - HEAT[i]) * (x - i)[..., None]


@lru_cache(maxsize=2)
def _brain(size: int) -> tuple[np.ndarray, np.ndarray] | None:
    """The render placed in a size x size square: (rgb, silhouette 0-1), black background keyed out. None without the file."""
    if not BRAIN.exists():
        return None
    s = round(IMG * size)
    img = np.asarray(Image.open(BRAIN).convert("RGB").resize((s, s), Image.LANCZOS), float)
    rgb = np.zeros((size, size, 3))
    o = (size - s) // 2
    rgb[o : o + s, o : o + s] = img
    return rgb, np.clip((rgb.max(axis=-1) - 8) * 8 / 255, 0, 1)


def _brain_layer(grid, size: int) -> Image.Image:
    """The lit brain with the heat on it, as RGBA over transparent."""
    v = np.asarray(Image.fromarray(np.asarray(grid, np.float32), "F").resize((size, size), Image.BICUBIC), float)
    t = np.clip((v - 0.2) / 0.45, 0, 1)
    heat_a = (t * t * (3 - 2 * t) * 0.94)[..., None]  # lib/brain.ts heatPixel: low likelihood stays clear
    heat = _heat((v - 0.15) / 0.75)
    brain = _brain(size)
    if brain is None:  # no render next to the agent: the heat alone inside the head outline
        yy, xx = np.mgrid[-1 : 1 : size * 1j, -1 : 1 : size * 1j]
        inside = ((xx / HEAD_RX) ** 2 + (yy / HEAD_RY) ** 2 <= 1).astype(float)
        base, mask = np.full((size, size, 3), 0x17, float), inside
    else:
        base, mask = brain
    rgb = base * (1 - heat_a) + heat * heat_a
    return Image.fromarray(np.dstack([rgb, mask * 255]).clip(0, 255).astype(np.uint8), "RGBA")


@lru_cache(maxsize=16)
def _font(weight: int, px: int) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(str(FONTS / f"Switzer-{weight}.woff2"), px)
    except OSError:
        return ImageFont.load_default(px)


def _text(draw: ImageDraw.ImageDraw, xy: tuple[float, float], text: str, weight: int, px: int, fill, tracking: float = 0, anchor: str = "l") -> None:
    """One line with CSS-style letter-spacing (`tracking` in em). `anchor`: l, m or r for the x position."""
    font, gap = _font(weight, px), tracking * px
    width = sum(font.getlength(c) + gap for c in text) - gap
    x = xy[0] - {"l": 0, "m": width / 2, "r": width}[anchor]
    for c in text:
        draw.text((x, xy[1]), c, font=font, fill=fill)
        x += font.getlength(c) + gap


def map_png(grid, result: dict | None = None, width_px: int = 1080) -> bytes:
    """A map grid (e.g. 64x64, values 0-1) as PNG bytes: the brain with the heat on it, and under it the result.

    `result` is the scan as the medic approved it: `status`, `region`, `volume_ml`, `confidence`, and optionally `patient_id`.
    """
    w, k = width_px, width_px / 1080
    h = round(w * 1.25)
    out = Image.new("RGB", (w, h), BG)
    size = round(880 * k)
    layer = _brain_layer(grid, size)
    out.paste(layer, ((w - size) // 2, round(86 * k)), layer)

    d = ImageDraw.Draw(out)
    label = dict(weight=500, px=round(22 * k), fill=MUTED, tracking=0.12)
    mid = round(86 * k) + size // 2
    _text(d, (w / 2, 40 * k), "FRONT", anchor="m", **label)
    _text(d, (56 * k, mid - 12 * k), "L", anchor="m", **label)
    _text(d, (w - 56 * k, mid - 12 * k), "R", anchor="m", **label)

    x, y = 72 * k, 1010 * k
    d.line([(x, y), (w - x, y)], fill=LINE, width=max(1, round(2 * k)))
    r = result or {}
    _text(d, (x, y + 36 * k), "LUCID  ·  SCREENING MAP", **label)
    # Likelihood scale, right-aligned on the label row.
    bar_w, bar_h = round(190 * k), max(4, round(8 * k))
    bx, by = round(w - x - bar_w), round(y + 46 * k)
    ramp = _heat(np.linspace(0.15, 1, bar_w))[None].repeat(bar_h, 0).astype(np.uint8)
    out.paste(Image.fromarray(ramp, "RGB"), (bx, by))
    _text(d, (bx - 16 * k, y + 36 * k), "LIKELIHOOD", anchor="r", **label)

    _text(d, (x - 3 * k, y + 84 * k), VERDICT.get(r.get("status"), "Screening map"), 600, round(84 * k), TEXT, tracking=-0.04)
    if r.get("status") == "bleed":
        parts = [r.get("region"), r.get("volume_ml") and f"about {r['volume_ml']} mL", r.get("confidence") and f"fit {r['confidence']:.2f}"]
        _text(d, (x, y + 196 * k), "  ·  ".join(p for p in parts if p), 400, round(36 * k), TEXT)
    foot = " ".join(filter(None, [f"Patient {r['patient_id']}." if r.get("patient_id") else "", CAPTION]))
    _text(d, (x, y + 262 * k), foot, 400, round(26 * k), MUTED)

    buf = io.BytesIO()
    out.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
