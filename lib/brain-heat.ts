/** 3D-only scan field. Head frame: +x right ear, +y nose, +z up; millimetres. */
export type Point3 = readonly [number, number, number];
export type BleedKind = "epidural" | "subdural" | "intraparenchymal";
// Same scripted patient as lib/mock.ts; intentionally leaves the 2D mock untouched.
export const DEMO_BLEED = { type: "epidural" as BleedKind, angle: 268, volume: 22 };
export function scalpSpot3D(spot: number): Point3 {
  const a = spot * Math.PI / 4;
  return [Math.sin(a) * 66.2, Math.cos(a) * 74, 15];
}
export function bleedCenter3D(angle: number, type: BleedKind = "epidural"): Point3 {
  const a = angle * Math.PI / 180, radius = type === "intraparenchymal" ? 0.5 : 0.92;
  return [Math.sin(a) * 66.2 * radius, Math.cos(a) * 74 * radius, 12];
}
export function bleedLikelihood3D(point: Point3, type: BleedKind, angle: number, volume: number) {
  if (!Number.isFinite(volume) || volume <= 0) return 0;
  const size = Math.cbrt(volume / 20), c = bleedCenter3D(angle, type), a = angle * Math.PI / 180;
  const x = point[0] - c[0], y = point[1] - c[1], z = point[2] - c[2];
  const normal = x * Math.sin(a) + y * Math.cos(a), tangent = x * Math.cos(a) - y * Math.sin(a);
  if (type === "intraparenchymal") return Math.exp(-(x * x + y * y + z * z) / (2 * (14 * size) ** 2));
  if (type === "subdural") return Math.exp(-0.5 * ((normal / (4.5 * size)) ** 2 + (tangent / (36 * size)) ** 4 + (z / (20 * size)) ** 2));
  // A compact lens: comparable horizontal/vertical tangent extents, never a column.
  return Math.exp(-0.5 * ((normal / (8 * size)) ** 2 + (tangent / (17 * size)) ** 2 + (z / (15 * size)) ** 2));
}
export function scanCoverage3D(point: Point3, spots: readonly number[]) {
  let coverage = 0;
  for (const spot of spots) {
    const p = scalpSpot3D(spot), distance2 = (point[0] - p[0]) ** 2 + (point[1] - p[1]) ** 2 + (point[2] - p[2]) ** 2;
    coverage = Math.max(coverage, Math.exp(-distance2 / (2 * 55 ** 2)));
  }
  return Math.max(0, Math.min(1, (coverage - 0.18) / 0.35));
}
export function displayToHead(point: Point3): Point3 {
  return [point[0] / (0.676 * 0.97 / 66.2), point[1] / (0.92 * 0.97 / 74), point[2] / 0.011 + 8];
}
export function heatAttributes(positions: ArrayLike<number>, previous: readonly number[], next: readonly number[]) {
  const n = positions.length / 3, heat = new Float32Array(n), before = new Float32Array(n), after = new Float32Array(n), head = new Float32Array(positions.length);
  for (let i = 0; i < n; i++) {
    const point = displayToHead([positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
    head.set(point, i * 3);
    heat[i] = Math.min(1, 0.09 + 0.9 * bleedLikelihood3D(point, DEMO_BLEED.type, DEMO_BLEED.angle, DEMO_BLEED.volume));
    before[i] = scanCoverage3D(point, previous); after[i] = scanCoverage3D(point, next);
  }
  return { heat, before, after, head };
}
