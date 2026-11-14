/** Framework-free cortex deformation. Coordinates in the source mesh are mm. */
export interface Hemisphere {
  vertices: number[];
  faces: number[];
  sulc: number[];
  inflated: number[];
  blob: number[];
}
export interface CortexModel { left: Hemisphere; right: Hemisphere }
export interface FoldingParameters { folding: number; depth: number }
export const DEFAULT_FOLDING: Readonly<FoldingParameters> = { folding: 1, depth: 1 };
export const FOLDING_LIMITS = { folding: [0, 1], depth: [0, 2] } as const;

export function clampParameter(value: number, min: number, max: number, fallback: number) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

/** Area-weighted smooth normals, recomputed on the deformed topology. */
export function surfaceNormals(positions: ArrayLike<number>, faces: ArrayLike<number>, out: Float32Array = new Float32Array(positions.length)) {
  out.fill(0);
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) { out[i] += nx; out[i + 1] += ny; out[i + 2] += nz; }
  }
  for (let i = 0; i < out.length; i += 3) {
    const length = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
    out[i] /= length; out[i + 1] /= length; out[i + 2] /= length;
  }
  return out;
}

function smoothstep(value: number) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

export function prepareHemisphere(source: Hemisphere) {
  // Lightly soften the pial sheet, then expand its gyral walls along their
  // own normals. Opposing walls approach each other, closing open valleys
  // while retaining the anatomical folding pattern and rounded crowns.
  const softened = new Float32Array(source.vertices.length);
  for (let i = 0; i < softened.length; i++) softened[i] = source.vertices[i] * 0.85 + source.inflated[i] * 0.15;
  const normals = surfaceNormals(softened, source.faces);
  const closed = new Float32Array(source.vertices.length);
  const shallow = new Float32Array(source.vertices.length);
  const side = source.vertices.filter((_, i) => i % 3 === 0).reduce((a, b) => a + b, 0) < 0 ? -1 : 1;
  for (const [out, expansion] of [[closed, 4.0], [shallow, 5.5]] as const) {
    for (let i = 0; i < out.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const j = i + axis;
        out[j] = softened[j] + normals[j] * expansion;
      }
      // Compensate the exterior expansion to retain the established scan outline.
      out[i] *= 0.96;
      out[i + 1] *= 0.97;
      // Leave a fine medial fissure rather than an open interhemispheric canyon.
      const medialDistance = Math.max(0, side * out[i]);
      out[i] = side * Math.max(0.25, medialDistance - 2 * Math.exp(-medialDistance / 12));
    }
  }
  return { source, closed, shallow };
}
export type PreparedHemisphere = ReturnType<typeof prepareHemisphere>;

/**
 * Folding continuously blends the smooth envelope into closed, plump gyri.
 * Depth 0 further fills the clefts, 1 is the closed-sulcus default, and
 * only depth 2 reaches the original, open pial surface. The source anatomy is
 * retained at both ends; there is no synthetic noise or topology replacement.
 */
export function deformHemisphere(prepared: PreparedHemisphere, parameters: FoldingParameters, out: Float32Array = new Float32Array(prepared.source.vertices.length)) {
  const folding = clampParameter(parameters.folding, 0, 1, DEFAULT_FOLDING.folding);
  const depth = clampParameter(parameters.depth, 0, 2, DEFAULT_FOLDING.depth);
  const { source, closed, shallow } = prepared;
  const amount = smoothstep(folding);
  const opening = smoothstep(depth - 1);
  const flatten = smoothstep(1 - depth);
  for (let i = 0; i < out.length; i++) {
    const filled = closed[i] + (shallow[i] - closed[i]) * flatten;
    const folded = filled + (source.vertices[i] - filled) * opening;
    out[i] = source.blob[i] + (folded - source.blob[i]) * amount;
  }
  return out;
}

/** Source +x right ear, +y nose, +z up → the existing Scan map proportions. */
export function toDisplayPositions(mm: ArrayLike<number>, side: "left" | "right", out: Float32Array = new Float32Array(mm.length)) {
  for (let i = 0; i < mm.length; i += 3) {
    const x = mm[i] * (0.676 * 0.97 / 66.2);
    // Smoothed medial walls may cross the midline. Keep a quiet fissure instead.
    out[i] = side === "left" ? Math.min(-0.003, x) : Math.max(0.003, x);
    out[i + 1] = mm[i + 1] * (0.92 * 0.97 / 74);
    out[i + 2] = (mm[i + 2] - 8) * 0.011;
  }
  return out;
}

/** Radius in map coordinates, cubic-out over the original 1.4 second reveal. */
export function scanRevealRadius(elapsedMs: number, reducedMotion = false) {
  const t = reducedMotion ? 1 : Math.max(0, Math.min(1, elapsedMs / 1400));
  return 3 * (1 - (1 - t) ** 3);
}
