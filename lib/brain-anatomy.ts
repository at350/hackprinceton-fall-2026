/** Anatomical cortical topology with seeded, bounded surface deformation. */
import { surfaceNormals, toDisplayPositions, type Hemisphere } from "./brain-geometry.ts";
export const DEFAULT_SEED = 1731;
export function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => { state += 0x6d2b79f5; let t = Math.imul(state ^ (state >>> 15), 1 | state); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const smooth = (a: number, b: number, v: number) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

function neighbors(count: number, faces: ArrayLike<number>) {
  const sets = Array.from({ length: count }, () => new Set<number>());
  for (let i = 0; i < faces.length; i += 3) {
    const a = faces[i], b = faces[i + 1], c = faces[i + 2];
    sets[a].add(b).add(c); sets[b].add(a).add(c); sets[c].add(a).add(b);
  }
  return sets.map((set) => Array.from(set));
}
function diffuse(positions: Float32Array, adjacent: number[][], passes: number) {
  let current = positions.slice(), next = current.slice();
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < adjacent.length; i++) for (let a = 0; a < 3; a++) {
      let sum = 0;
      for (const j of adjacent[i]) sum += current[j * 3 + a];
      next[i * 3 + a] = current[i * 3 + a] * 0.5 + sum / Math.max(1, adjacent[i].length) * 0.5;
    }
    [current, next] = [next, current];
  }
  return current;
}
function refine(positions: Float32Array, faces: Uint32Array, sulc: Float32Array) {
  const points = Array.from(positions), field = Array.from(sulc), indices: number[] = [], edges = new Map<number, number>(), n = positions.length / 3;
  function middle(a: number, b: number) {
    const key = Math.min(a, b) * n + Math.max(a, b), cached = edges.get(key);
    if (cached !== undefined) return cached;
    const index = points.length / 3;
    for (let axis = 0; axis < 3; axis++) points.push((positions[a * 3 + axis] + positions[b * 3 + axis]) * 0.5);
    field.push((sulc[a] + sulc[b]) * 0.5); edges.set(key, index); return index;
  }
  for (let i = 0; i < faces.length; i += 3) {
    const a = faces[i], b = faces[i + 1], c = faces[i + 2], ab = middle(a, b), bc = middle(b, c), ca = middle(c, a);
    indices.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  return { positions: new Float32Array(points), faces: new Uint32Array(indices), sulc: new Float32Array(field) };
}

/** A fixed convex outer support, fitted to the actual crown/lobe silhouette. */
function supportPlanes(positions: Float32Array) {
  const directions = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let i = 0; i < 80; i++) {
    const y = 1 - (i + 0.5) / 40, r = Math.sqrt(1 - y * y), a = i * Math.PI * (3 - Math.sqrt(5));
    directions.push([Math.cos(a) * r, y, Math.sin(a) * r]);
  }
  return directions.map(([x, y, z]) => {
    let bound = -Infinity;
    for (let i = 0; i < positions.length; i += 3) bound = Math.max(bound, x * positions[i] + y * positions[i + 1] + z * positions[i + 2]);
    return [x, y, z, bound];
  });
}
function constrain(position: Float32Array, planes: number[][]) {
  for (let i = 0; i < position.length; i += 3) for (let repeat = 0; repeat < 2; repeat++) for (const [x, y, z, bound] of planes) {
    const outside = position[i] * x + position[i + 1] * y + position[i + 2] * z - bound;
    if (outside > 0) { position[i] -= x * outside; position[i + 1] -= y * outside; position[i + 2] -= z * outside; }
  }
}
export function prepareAnatomy(source: Hemisphere, side: "left" | "right", subdivisions = 1) {
  if (!Number.isInteger(subdivisions) || subdivisions < 0 || subdivisions > 2) throw new RangeError("Invalid subdivision count");
  const mm = diffuse(Float32Array.from(source.vertices), neighbors(source.sulc.length, source.faces), 6), sign = side === "left" ? -1 : 1;
  for (let i = 0; i < mm.length; i += 3) {
    mm[i] *= 0.96; mm[i + 1] *= 0.97;
    const distance = Math.max(0, sign * mm[i]);
    mm[i] = sign * Math.max(0.25, distance - 2 * Math.exp(-distance / 12));
  }
  let mesh = { positions: toDisplayPositions(mm, side), faces: Uint32Array.from(source.faces), sulc: Float32Array.from(source.sulc) };
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const y = mesh.positions[i + 1];
    const fissure = 0.014 * Math.sin(y * 7 + 0.4) + 0.003 * Math.sin(y * 19);
    const gap = 0.0015 + 0.002 * (0.5 + 0.5 * Math.sin(y * 11));
    mesh.positions[i] = sign * Math.max(gap, Math.abs(mesh.positions[i])) + fissure * Math.exp(-Math.abs(mesh.positions[i]) / 0.05);
  }
  const coarseBase = toDisplayPositions(source.inflated, side);
  let coarse = { positions: coarseBase, faces: mesh.faces, sulc: mesh.sulc };
  for (let i = 0; i < subdivisions; i++) { mesh = refine(mesh.positions, mesh.faces, mesh.sulc); coarse = refine(coarse.positions, coarse.faces, coarse.sulc); }
  const adjacent = neighbors(mesh.sulc.length, mesh.faces), planes = supportPlanes(mesh.positions);
  const center = [sign * 0.28, 0, 0];
  const envelope = new Float32Array(mesh.positions.length);
  for (let i = 0; i < envelope.length; i += 3) {
    const direction = [coarse.positions[i] - center[0], coarse.positions[i + 1], coarse.positions[i + 2]];
    const length = Math.hypot(...direction) || 1;
    for (let a = 0; a < 3; a++) direction[a] /= length;
    let radius = Infinity;
    for (const [x, y, z, bound] of planes) {
      const facing = x * direction[0] + y * direction[1] + z * direction[2];
      if (facing > 1e-6) radius = Math.min(radius, (bound - x * center[0]) / facing);
    }
    for (let a = 0; a < 3; a++) envelope[i + a] = center[a] + direction[a] * radius;
  }
  return { positions: diffuse(envelope, adjacent, 20), anatomical: mesh.positions, coarse: coarse.positions, faces: mesh.faces, sulc: mesh.sulc, adjacent, planes, normals: surfaceNormals(mesh.positions, mesh.faces) };
}
export type Anatomy = ReturnType<typeof prepareAnatomy>;

/** Anatomical field warps move existing folds; branches add real new clefts. */
export function generateAnatomicalFolds(a: Anatomy, seed: number, count: number) {
  const t = Number.isFinite(count) ? Math.max(0, Math.min(1, count)) : 0.5;
  const random = seededRandom(seed), phase = Array.from({ length: 6 }, () => random() * Math.PI * 2), out = new Float32Array(a.positions.length);
  const amount = smooth(0, 0.5, t);
  for (let i = 0; i < out.length; i += 3) {
    const x = a.anatomical[i], y = a.anatomical[i + 1], z = a.anatomical[i + 2];
    let margin = Infinity;
    for (const [nx, ny, nz, bound] of a.planes) margin = Math.min(margin, bound - nx * x - ny * y - nz * z);
    const warp = [Math.sin(y * 8 + phase[0]) * Math.cos(z * 7 + phase[1]), Math.sin(x * 9 + phase[2]) * Math.cos(z * 6 + phase[3]), Math.sin(y * 7 + phase[4]) * Math.cos(x * 8 + phase[5])];
    for (let axis = 0; axis < 3; axis++) {
      const j = i + axis;
      const low = a.positions[j] * 0.80 + a.coarse[j] * 0.20;
      const folded = a.positions[j] * 0.2 + a.anatomical[j] * 0.8;
      out[j] = low + (folded - low) * amount + warp[axis] * 0.027 * amount * smooth(0, 0.06, margin) * smooth(0.005, 0.05, Math.abs(x));
    }
  }
  // Walk the mesh to grow curved tertiary clefts from real sulcal banks. The
  // path follows changing surface tangents instead of stamping straight stripes.
  const branches = Math.round(800 * smooth(0.50, 1, t));
  const vertexCount = a.sulc.length, tertiary = new Float32Array(vertexCount);
  for (let branch = 0; branch < branches; branch++) {
    const anchor = Math.floor(random() * vertexCount);
    if (a.sulc[anchor] > 0.4 || tertiary[anchor] > 0.006) continue;
    let current = anchor;
    let next = a.adjacent[anchor].reduce((best, j) => a.sulc[j] < a.sulc[best] ? j : best, anchor);
    if (next === anchor) continue;
    let direction = [out[next * 3] - out[current * 3], out[next * 3 + 1] - out[current * 3 + 1], out[next * 3 + 2] - out[current * 3 + 2]];
    const steps = 18 + Math.floor(random() * 14), width = 0.023 + random() * 0.008;
    const amplitude = 0.008 * smooth(0.5, 1, t), visited = new Set<number>(), path: number[] = [];
    for (let step = 0; step < steps; step++) {
      if (visited.has(current) || (step > 2 && a.sulc[current] > 0.65)) break;
      visited.add(current);
      path.push(current);
      const length = Math.hypot(...direction) || 1;
      direction = direction.map((v) => v / length);
      let best = -Infinity; next = current;
      for (const j of a.adjacent[current]) {
        if (visited.has(j)) continue;
        const d = [out[j * 3] - out[current * 3], out[j * 3 + 1] - out[current * 3 + 1], out[j * 3 + 2] - out[current * 3 + 2]];
        const l = Math.hypot(...d) || 1;
        const score = (d[0] * direction[0] + d[1] * direction[1] + d[2] * direction[2]) / l - a.sulc[j] * 0.3;
        if (score > best) { best = score; next = j; }
      }
      direction = [out[next * 3] - out[current * 3], out[next * 3 + 1] - out[current * 3 + 1], out[next * 3 + 2] - out[current * 3 + 2]];
      current = next;
    }
    if (path.length < 5) continue;
    // Smooth long sulcal branches, with a wide rounded bank rather than tiny
    // triangular incisions. The branch starts on an existing anatomical bank.
    let line = path.map((index) => [out[index * 3], out[index * 3 + 1], out[index * 3 + 2]]);
    for (let pass = 0; pass < 3; pass++) line = line.map((p, i) => i === 0 || i === line.length - 1 ? p : p.map((v, axis) => (v * 2 + line[i - 1][axis] + line[i + 1][axis]) / 4));
    const min = [0, 1, 2].map((axis) => Math.min(...line.map((p) => p[axis])) - width * 2);
    const max = [0, 1, 2].map((axis) => Math.max(...line.map((p) => p[axis])) + width * 2);
    for (let j = 0; j < vertexCount; j++) {
      const p = [out[j * 3], out[j * 3 + 1], out[j * 3 + 2]];
      if (p.some((v, axis) => v < min[axis] || v > max[axis])) continue;
      let cut = 0;
      for (let k = 0; k < line.length; k++) {
        const q = line[k], d2 = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
        cut = Math.max(cut, amplitude * Math.sin(Math.PI * (k + 1) / (line.length + 1)) * Math.exp(-d2 / (2 * width * width)));
      }
      tertiary[j] = Math.max(tertiary[j], cut);
    }
  }
  const envelopeNormals = surfaceNormals(a.positions, a.faces);
  for (let i = 0; i < out.length; i++) out[i] -= envelopeNormals[i] * tertiary[Math.floor(i / 3)];
  constrain(out, a.planes);
  return Float32Array.from(a.positions, (p, i) => p - out[i]);
}
export function deformAnatomy(a: Anatomy, delta: Float32Array, depth: number) {
  const d = Number.isFinite(depth) ? Math.max(0, Math.min(2, depth)) : 1;
  const scale = d <= 1 ? d : 1 + (d - 1) * 0.2;
  return Float32Array.from(a.positions, (p, i) => p - delta[i] * scale);
}
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
export function foldAttributes(a: Anatomy, delta: Float32Array, count = 0.5) {
  const folded = deformAnatomy(a, delta, 1), deep = deformAnatomy(a, delta, 2);
  const foldNormal = surfaceNormals(folded, a.faces), cavity = surfaceCavity(folded, foldNormal, a.faces);
  let sulc = cavity;
  for (let pass = 0; pass < 5; pass++) sulc = Float32Array.from(sulc, (v, i) => (v * 2 + a.adjacent[i].reduce((sum, j) => sum + sulc[j], 0) / Math.max(1, a.adjacent[i].length)) / 3);
  for (let i = 0; i < sulc.length; i++) sulc[i] *= smooth(0, 0.5, count);
  return { delta, foldNormal, deepNormal: surfaceNormals(deep, a.faces), sulc };
}
