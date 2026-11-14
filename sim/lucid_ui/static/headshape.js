// A head shape instead of a ball: longer front to back, narrower side to side, a rounder crown and a flatter
// base, with a brow, nose and ears on the scalp. Sized to hold the fitted cortex (x ±66, y ±74, z -51..66 mm)
// with room for the skull. Head frame: +x right ear, +y nose, +z up, mm. The scan spots are directions, so
// they sit wherever this surface is in that direction.
import * as THREE from 'three';

const AX = 82, AY = 100, AZ_TOP = 96, AZ_BASE = 74;
const SKULL_MM = 7;  // scalp plus soft tissue between the skin and the bone

const bump = (d, centre, width, height) => {
  const c = Math.min(1, Math.max(-1, d.dot(centre)));
  const a = Math.acos(c);
  return height * Math.exp(-(a * a) / (2 * width * width));
};
const NOSE = new THREE.Vector3(0, 0.96, -0.28).normalize();
const BROW_L = new THREE.Vector3(-0.32, 0.92, 0.08).normalize();
const BROW_R = new THREE.Vector3(0.32, 0.92, 0.08).normalize();
const EAR_L = new THREE.Vector3(-1, -0.05, -0.08).normalize();
const EAR_R = new THREE.Vector3(1, -0.05, -0.08).normalize();
const BACK = new THREE.Vector3(0, -0.92, 0.25).normalize();

function base(d) {
  const az = d.z >= 0 ? AZ_TOP : AZ_BASE;
  return 1 / Math.sqrt((d.x / AX) ** 2 + (d.y / AY) ** 2 + (d.z / az) ** 2);
}

// Distance from the centre to the skin, in direction d (a unit vector).
export function scalpRadius(d) {
  return base(d) + bump(d, NOSE, 0.1, 16) + bump(d, BROW_L, 0.16, 3) + bump(d, BROW_R, 0.16, 3)
    + bump(d, EAR_L, 0.1, 9) + bump(d, EAR_R, 0.1, 9) + bump(d, BACK, 0.45, 4);
}

// Distance to the outside of the skull: the head without nose and ears, a scalp's thickness in.
export function skullRadius(d) {
  return base(d) + bump(d, BACK, 0.45, 4) + bump(d, BROW_L, 0.16, 2) + bump(d, BROW_R, 0.16, 2) - SKULL_MM;
}

export function headGeometry(radiusOf, detail = 140) {
  const geo = new THREE.SphereGeometry(1, detail, Math.round(detail * 0.75));
  const p = geo.attributes.position, d = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    d.fromBufferAttribute(p, i).normalize();
    p.setXYZ(i, ...d.clone().multiplyScalar(radiusOf(d)).toArray());
  }
  geo.computeVertexNormals();
  return geo;
}
