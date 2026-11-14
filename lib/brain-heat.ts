/** Axial scan-map projection. Head frame: +x right, +y nose, +z up, in mm. */
export type Point3 = readonly [number, number, number];
const RX = 0.676, RY = 0.92;
export const RIM_HEAT_BAND = 12 * Math.PI / 180;
export const RIM_SAMPLE_BAND = 10 * Math.PI / 180;
const smooth = (t: number) => { const k = Math.max(0, Math.min(1, t)); return k * k * (3 - 2 * k); };

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

/**
 * Ease the radial derivative to zero across a 20° band (several 64-grid texels).
 * Both sides use the same footprint-normalized map; there is no brightness
 * branch at the equator. The short heat tail starts with zero fade slope.
 */
export function projectCortexMap(point: Point3) {
  const p = projectAxialMap(point);
  const offset = (p.radius / 0.97 - 1) * Math.PI / 2;
  const h = RIM_SAMPLE_BAND;
  const mapped = offset <= -h ? offset : offset >= h ? 0 : -((h - offset) ** 2) / (4 * h);
  const radius = 0.97 * (1 + mapped / (Math.PI / 2));
  const scale = p.radius > 0 ? radius / p.radius : 1;
  return {
    u: 0.5 + (p.u - 0.5) * scale, v: 0.5 + (p.v - 0.5) * scale,
    heatOpacity: 1 - smooth(offset / RIM_HEAT_BAND),
  };
}

/** Fragment-space counterpart: avoid triangle-interpolated rim/fade bands. */
export const cortexProjectionGLSL = `
  vec3 projectCortexMap(vec3 head) {
    float angle = atan(head.x, head.y);
    float polar = atan(length(head.xy / vec2(66.2, 74.0)), (head.z - 8.0) / 58.0);
    float offset = polar - ${Math.PI / 2};
    float h = ${RIM_SAMPLE_BAND};
    float mapped = offset <= -h ? offset : offset >= h ? 0.0 : -pow(h - offset, 2.0) / (4.0 * h);
    float radius = 0.97 * (1.0 + mapped / ${Math.PI / 2});
    vec2 direction = vec2(sin(angle), -cos(angle));
    vec2 uv = 0.5 + 0.5 * direction * radius / length(direction / vec2(${RX}, ${RY}));
    return vec3(uv, 1.0 - smoothstep(0.0, ${RIM_HEAT_BAND}, offset));
  }
`;

/** RGBA8: likelihood, coverage, unused, and the axial grid's valid footprint. */
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
    // Outside-head texels are padding, not evidence of an unscanned side.
    // Filtering this mask lets the rim coverage ignore padding, while zeros
    // INSIDE the head remain unscanned. Normalize BOTH channels on BOTH sides.
    const x = size > 1 ? col * 2 / (size - 1) - 1 : 0;
    const y = size > 1 ? row * 2 / (size - 1) - 1 : 0;
    data[offset + 3] = Math.hypot(x / RX, y / RY) <= 0.97 ? 255 : 0;
  }
  return { size, data };
}

export function mapVertexAttributes(positions: ArrayLike<number>) {
  const count = positions.length / 3, head = new Float32Array(positions.length);
  for (let i = 0; i < count; i++) {
    const point = displayToHead([positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
    head.set(point, i * 3);
  }
  return { head };
}
