/** Framework-free geometry and scan reveal helpers. */
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
