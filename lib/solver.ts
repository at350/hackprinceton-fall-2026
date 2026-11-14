"use client";

import { AGENT_URL } from "./live";
import type { SpotReading } from "./types";

// The head model the agent's solver works on, and one solve per hypothesis.
// Served by the agent (live mode only). Coordinates match lib/mock.ts.

export type Tissue = "scalp" | "skull" | "csf" | "brain";

export interface HeadMesh {
  nodes: [number, number][];
  triangles: [number, number, number][];
  tissue: Tissue[]; // per triangle
  electrodes: number[]; // node index of each of the 16 electrodes
  spot_pairs: [number, number][]; // the electrode pair each scan spot drives
}

export interface SimSolve {
  id: string;
  blood: number[]; // per triangle, 0-1 fraction that is blood
  change: number[][]; // per spot, per node: shift in potential vs a healthy head, -1..1
  reading: SpotReading;
  healthy: SpotReading;
  spots: string[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${AGENT_URL}${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

let mesh: Promise<HeadMesh> | null = null;
const solves = new Map<string, Promise<SimSolve>>();

/** The mesh never changes; fetched once. A failed fetch is retried on the next call. */
export function loadMesh() {
  mesh ??= get<HeadMesh>("/lucid/mesh").catch((e) => {
    mesh = null;
    throw e;
  });
  return mesh;
}

export function loadSolve(id: string) {
  let p = solves.get(id);
  if (!p) {
    p = get<SimSolve>(`/lucid/sim/${encodeURIComponent(id)}`).catch((e) => {
      solves.delete(id);
      throw e;
    });
    solves.set(id, p);
  }
  return p;
}

// ---- Drawing --------------------------------------------------------------
// Layers are square canvases covering map space [-1, 1], like the brain render.

type RGBA = [number, number, number, number];
type Shade = (w0: number, w1: number, w2: number) => RGBA | null;

// Muted grey at different strengths: bone lightest, fluid darkest.
const GREY = [0xac, 0xb5, 0xc0];
const TISSUE_ALPHA: Record<Tissue, number> = { scalp: 0.2, skull: 0.42, csf: 0.03, brain: 0.11 };
const BLEED = [0xff, 0x5a, 0x36];
const UP = [0x22, 0xc3, 0xe6]; // potential raised: primary
const DOWN = [0xed, 0xee, 0xf0]; // potential lowered: neutral

/**
 * Fill the mesh pixel by pixel. `setup` is called per triangle with its corners in
 * pixels and returns the shader for it (or null to skip the triangle); the shader
 * gets each pixel's weights towards the three nodes.
 */
function raster(m: HeadMesh, size: number, setup: (tri: number, x: number[], y: number[], area: number) => Shade | null) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const px = (v: number) => ((v + 1) / 2) * size;
  m.triangles.forEach(([a, b, d], t) => {
    const x0 = px(m.nodes[a][0]), y0 = px(m.nodes[a][1]);
    const x1 = px(m.nodes[b][0]), y1 = px(m.nodes[b][1]);
    const x2 = px(m.nodes[d][0]), y2 = px(m.nodes[d][1]);
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    const shade = area ? setup(t, [x0, x1, x2], [y0, y1, y2], area) : null;
    if (!shade) return;
    const left = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const right = Math.min(size - 1, Math.ceil(Math.max(x0, x1, x2)));
    const top = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const bottom = Math.min(size - 1, Math.ceil(Math.max(y0, y1, y2)));
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        const cx = x + 0.5, cy = y + 0.5;
        const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) / area;
        const w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) / area;
        const w2 = 1 - w0 - w1;
        // A hair of tolerance so shared edges leave no gaps.
        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
        const p = shade(w0, w1, w2);
        if (!p) continue;
        const k = (y * size + x) * 4;
        img.data[k] = p[0];
        img.data[k + 1] = p[1];
        img.data[k + 2] = p[2];
        img.data[k + 3] = p[3] * 255;
      }
    }
  });
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Scalp, skull, CSF and brain as flat greys. */
export function tissueLayer(m: HeadMesh, size: number) {
  return raster(m, size, (t) => {
    const p: RGBA = [GREY[0], GREY[1], GREY[2], TISSUE_ALPHA[m.tissue[t]]];
    return () => p;
  });
}

/** The hypothesised bleed: every triangle that holds blood. */
export function bleedLayer(m: HeadMesh, blood: number[], size: number) {
  return raster(m, size, (t) => {
    if (!(blood[t] > 0)) return null;
    const p: RGBA = [BLEED[0], BLEED[1], BLEED[2], 0.45 + 0.5 * blood[t]];
    return () => p;
  });
}

const LEVELS = 10;

/**
 * How far the bleed shifts the potential for one spot's injection: the disturbance
 * the device senses. Lines of equal shift over a faint wash. The levels are spaced
 * by the root of the shift, since most of the head moves by a few percent of the peak.
 */
export function fieldLayer(m: HeadMesh, change: number[], size: number) {
  const line = size / 520; // half-width of a contour, px
  return raster(m, size, (t, x, y, area) => {
    const [a, b, d] = m.triangles[t];
    const v0 = change[a], v1 = change[b], v2 = change[d];
    if (Math.max(Math.abs(v0), Math.abs(v1), Math.abs(v2)) < 0.005) return null;
    // The shift is linear across a triangle, so its slope (per px) is constant.
    const gx = (v0 * (y[1] - y[2]) + v1 * (y[2] - y[0]) + v2 * (y[0] - y[1])) / area;
    const gy = (v0 * (x[2] - x[1]) + v1 * (x[0] - x[2]) + v2 * (x[1] - x[0])) / area;
    const slope = Math.hypot(gx, gy);
    return (w0, w1, w2) => {
      const v = v0 * w0 + v1 * w1 + v2 * w2;
      const mag = Math.min(1, Math.abs(v));
      const u = Math.sqrt(mag) * LEVELS;
      const level = Math.round(u);
      // Levels per px here. Where the field is flat there is no contour to draw.
      const steep = (slope * LEVELS) / (2 * Math.sqrt(mag) + 1e-9);
      // Distance to the nearest contour in px, for an even line.
      const dist = level && steep * size > 0.8 ? Math.abs(u - level) / steep : Infinity;
      const alpha = Math.max(0.3 * mag, 0.75 * Math.min(1, Math.max(0, line + 0.5 - dist)));
      const rgb = v > 0 ? UP : DOWN;
      return alpha > 0.004 ? [rgb[0], rgb[1], rgb[2], alpha] : null;
    };
  });
}
