/** Axial scan-map projection. Head frame: +x right, +y nose, +z up, in mm. */
export type Point3 = readonly [number, number, number];
const RX = 0.676, RY = 0.92;

export function scalpSpot3D(spot: number): Point3 {
  const a = spot * Math.PI / 4;
  return [Math.sin(a) * 66.2, Math.cos(a) * 74, 15];
}
export function displayToHead(point: Point3): Point3 {
  return [point[0] / (RX * 0.97 / 66.2), point[1] / (RY * 0.97 / 74), point[2] / 0.011 + 8];
}

/**
 * Azimuthal equidistant projection of the fitted head ellipsoid. Angular
 * distance from the crown replaces planar x/y radius: the crown maps to r=0,
 * the lateral equator to r=.97. Radius continues increasing below the equator
 * (never clamped to the rim), so a map pixel cannot smear down a lateral wall.
 * Raw azimuth atan2(x,y) matches mock.polar(): 0=nose, clockwise from above.
 */
export function projectAxialMap([x, y, z]: Point3) {
  const angle = Math.atan2(x, y);
  const polar = Math.atan2(Math.hypot(x / 66.2, y / 74), (z - 8) / 58);
  const radius = 0.97 * polar / (Math.PI / 2);
  const sin = Math.sin(angle), cos = Math.cos(angle);
  // Fit the ellipse without changing azimuth; mock.polar uses raw map x/y.
  const distance = radius / Math.hypot(sin / RX, cos / RY);
  const mapX = sin * distance, mapY = -cos * distance;
  return { u: (mapX + 1) / 2, v: (mapY + 1) / 2, radius, angle };
}

/** RGBA8: likelihood and the 2D renderer's coverage rule, without inference. */
export function mapTextureData(map: readonly (readonly number[])[] | null) {
  const size = map?.length || 1;
  if (size > 512 || (map?.length && map.some((row) => row.length !== size))) throw new RangeError("Invalid axial map dimensions");
  const data = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    const raw = map?.[row]?.[col] ?? 0;
    const value = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
    const offset = (row * size + col) * 4;
    data[offset] = Math.round(value * 255);
    data[offset + 1] = Math.round(Math.min(1, value / 0.06) * 255);
    data[offset + 3] = 255;
  }
  return { size, data };
}

export function mapVertexAttributes(positions: ArrayLike<number>) {
  const count = positions.length / 3, uv = new Float32Array(count * 2), head = new Float32Array(positions.length);
  for (let i = 0; i < count; i++) {
    const point = displayToHead([positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
    const p = projectAxialMap(point);
    head.set(point, i * 3); uv[i * 2] = p.u; uv[i * 2 + 1] = p.v;
  }
  return { uv, head };
}
