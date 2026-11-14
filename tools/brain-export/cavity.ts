/** Local diffuse occlusion from surface patches, computed only in the worker/exporter. */
export function surfaceCavity(positions: Float32Array, normals: Float32Array, faces: Uint32Array) {
  const count = positions.length / 3, areas = new Float32Array(count), cell = 0.10;
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f], b = faces[f + 1], c = faces[f + 2];
    const ux = positions[b * 3] - positions[a * 3], uy = positions[b * 3 + 1] - positions[a * 3 + 1], uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const vx = positions[c * 3] - positions[a * 3], vy = positions[c * 3 + 1] - positions[a * 3 + 1], vz = positions[c * 3 + 2] - positions[a * 3 + 2];
    const share = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 6;
    areas[a] += share; areas[b] += share; areas[c] += share;
  }
  const bins = new Map<number, number[]>();
  const key = (x: number, y: number, z: number) => (x + 40) * 10000 + (y + 40) * 100 + z + 40;
  // Every second patch is a deterministic quadrature sample; double its area.
  for (let i = 0; i < count; i += 2) {
    const k = key(Math.floor(positions[i * 3] / cell), Math.floor(positions[i * 3 + 1] / cell), Math.floor(positions[i * 3 + 2] / cell));
    const bin = bins.get(k); if (bin) bin.push(i); else bins.set(k, [i]);
  }
  const cavity = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let occlusion = 0;
    for (let bx = -1; bx <= 1; bx++) for (let by = -1; by <= 1; by++) for (let bz = -1; bz <= 1; bz++) {
      for (const j of bins.get(key(cx + bx, cy + by, cz + bz)) ?? []) {
        const dx = positions[j * 3] - x, dy = positions[j * 3 + 1] - y, dz = positions[j * 3 + 2] - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 0.000025 || d2 > cell * cell) continue;
        const facing = normals[i * 3] * dx + normals[i * 3 + 1] * dy + normals[i * 3 + 2] * dz;
        if (facing <= 0) continue;
        const other = -(normals[j * 3] * dx + normals[j * 3 + 1] * dy + normals[j * 3 + 2] * dz);
        if (other > 0) occlusion += facing * other * areas[j] * 2 / (Math.PI * d2 * d2);
      }
    }
    cavity[i] = Math.min(1, occlusion);
  }
  return cavity;
}
