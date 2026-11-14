"use client";

import { heatRGB } from "@/components/ui";

// The render's brain spans 93.2% of the image height, centred. Drawing the image
// over [-IMG, IMG] in map space puts its silhouette on the HEAD ellipse at r = 0.97.
export const BRAIN_SRC = "/renders/brain-top.png";
export const IMG = (0.92 * 0.97) / 0.932;

let image: HTMLCanvasElement | null = null; // render with its black background keyed out
let mask: HTMLCanvasElement | null = null;
let ready: Promise<void> | null = null;

/** Load the render once and derive a silhouette mask from its black background. */
export function loadBrain() {
  if (ready) return ready;
  ready = new Promise<void>((resolve) => {
    const img = new Image();
    img.src = BRAIN_SRC;
    img.onload = () => {
      // Key out the black background so only the brain draws.
      const cut = document.createElement("canvas");
      cut.width = img.naturalWidth;
      cut.height = img.naturalHeight;
      const cx = cut.getContext("2d")!;
      cx.drawImage(img, 0, 0);
      const px = cx.getImageData(0, 0, cut.width, cut.height);
      for (let i = 0; i < px.data.length; i += 4) {
        const v = Math.max(px.data[i], px.data[i + 1], px.data[i + 2]);
        px.data[i + 3] = Math.max(0, Math.min(255, (v - 6) * 10));
      }
      cx.putImageData(px, 0, 0);
      image = cut;

      const c = document.createElement("canvas");
      c.width = c.height = 512;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0, 512, 512);
      const d = ctx.getImageData(0, 0, 512, 512);
      for (let i = 0; i < d.data.length; i += 4) {
        const v = Math.max(d.data[i], d.data[i + 1], d.data[i + 2]);
        d.data[i] = d.data[i + 1] = d.data[i + 2] = 255;
        d.data[i + 3] = Math.max(0, Math.min(255, (v - 8) * 8));
      }
      ctx.putImageData(d, 0, 0);
      mask = c;
      resolve();
    };
  });
  return ready;
}

function layer(size: number) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  return c;
}

/** Image rect for a canvas of `size` px covering map space [-1, 1]. */
function rect(size: number): [number, number, number, number] {
  const s = IMG * size;
  const o = (size - s) / 2;
  return [o, o, s, s];
}

/** Heat overlay alpha: low likelihood stays clear so the brain shows through. */
function heatPixel(v: number): [number, number, number, number] {
  const t = Math.min(1, Math.max(0, (v - 0.2) / 0.45));
  const a = t * t * (3 - 2 * t) * 0.94;
  const [r, g, b] = heatRGB((v - 0.15) / 0.75);
  return [r, g, b, a * 255];
}

function gridToCanvas(map: number[][], pixel: (v: number) => [number, number, number, number]) {
  const n = map.length;
  const c = layer(n);
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(n, n);
  for (let r = 0; r < n; r++) {
    for (let col = 0; col < n; col++) {
      const k = (r * n + col) * 4;
      const p = pixel(map[r][col]);
      img.data[k] = p[0];
      img.data[k + 1] = p[1];
      img.data[k + 2] = p[2];
      img.data[k + 3] = p[3];
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Scanned state: the brain lit wherever the map has coverage, heat on top,
 * all clipped to the brain silhouette. Unscanned areas stay transparent.
 */
export function renderScanned(map: number[][] | null, size: number, coverage = true) {
  const out = layer(size);
  if (!image || !mask || !map) return out;
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";

  if (coverage) {
    // Lit brain, masked by coverage (any map value > 0).
    const cov = gridToCanvas(map, (v) => [255, 255, 255, Math.min(255, (v / 0.06) * 255)]);
    ctx.drawImage(cov, 0, 0, size, size);
    ctx.globalCompositeOperation = "source-in";
    ctx.drawImage(image, ...rect(size));
    ctx.globalCompositeOperation = "source-over";
  } else {
    ctx.drawImage(image, ...rect(size));
  }

  // Heat, clipped to the silhouette.
  const heat = layer(size);
  const h = heat.getContext("2d")!;
  h.imageSmoothingQuality = "high";
  h.drawImage(gridToCanvas(map, heatPixel), 0, 0, size, size);
  h.globalCompositeOperation = "destination-in";
  h.drawImage(mask, ...rect(size));
  ctx.drawImage(heat, 0, 0);
  return out;
}

/** The whole brain, dimmed: what's not scanned yet. */
export function drawDimBrain(ctx: CanvasRenderingContext2D, size: number, alpha: number) {
  if (!image) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(image, ...rect(size));
  ctx.restore();
}
