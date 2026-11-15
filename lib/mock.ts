import type { DeviceSample, RegionName, ScanSpot, SignalQuality } from "./types";

// ---- Head geometry --------------------------------------------------------
// Axial view from above, nose up, patient's left on screen left.
// Map coordinates: x, y in [-1, 1], y = -1 is the nose.

// Matches the brain render's silhouette (width/height 0.735).
export const HEAD = { rx: 0.676, ry: 0.92 };

/** Angle in degrees, 0 = nose, clockwise from above (90 = patient's right). */
export function polar(x: number, y: number) {
  const r = Math.hypot(x / HEAD.rx, y / HEAD.ry);
  let a = (Math.atan2(x, -y) * 180) / Math.PI;
  if (a < 0) a += 360;
  return { r, a };
}

export function pointAt(angleDeg: number, r = 1) {
  const a = (angleDeg * Math.PI) / 180;
  return { x: Math.sin(a) * HEAD.rx * r, y: -Math.cos(a) * HEAD.ry * r };
}

// ---- Scan spots -----------------------------------------------------------

const SPOT_NAMES = [
  "Frontal",
  "R frontal",
  "R temporal",
  "R parietal",
  "Occipital",
  "L parietal",
  "L temporal",
  "L frontal",
];

export function initialSpots(): ScanSpot[] {
  return SPOT_NAMES.map((name, index) => ({
    index,
    name,
    angle: index * 45,
    state: "next",
    peak: null,
  }));
}

// ---- Region agents --------------------------------------------------------

export const REGIONS: RegionName[] = ["frontal", "temporal", "parietal", "occipital"];

// ---- Device stream --------------------------------------------------------

export interface DeviceContext {
  spot: number | null;
  moving: boolean; // between spots
  quality: SignalQuality;
}

// Deterministic noise.
function hash(n: number) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}
function noise(t: number, rate: number, seed: number) {
  const x = t * rate;
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return (hash(i + seed) * (1 - u) + hash(i + 1 + seed) * u) * 2 - 1;
}

let smoothRoll = 0;

/** One ~50 Hz device sample at wall time t (ms), from the simulated device. */
export function deviceSample(t: number, ctx: DeviceContext): DeviceSample {
  const s = t / 1000;
  const shake = ctx.moving ? 1.6 : ctx.quality === "weak" ? 0.9 : 0.25;
  const coil =
    -38.2 +
    0.5 * Math.sin(s * 2 * Math.PI * 0.27) +
    shake * noise(t, 0.03, 11) +
    0.12 * (hash(t) * 2 - 1);

  // NIR shows cardiac pulsation (~72 bpm) and respiration (~15/min).
  const beat = (s * 1.2) % 1;
  const pulse = Math.exp(-((beat - 0.15) ** 2) / 0.004) + 0.4 * Math.exp(-((beat - 0.42) ** 2) / 0.01);
  const nir =
    0.612 +
    0.028 * pulse +
    0.008 * Math.sin(s * 2 * Math.PI * 0.25) +
    (ctx.quality === "weak" ? 0.012 : 0.003) * noise(t, 0.05, 3);

  const targetRoll = ctx.spot === null ? 0 : Math.sin((ctx.spot * 45 * Math.PI) / 180) * 32;
  smoothRoll += (targetRoll - smoothRoll) * 0.03;
  const pitchBase = ctx.spot === null ? 4 : Math.cos((ctx.spot * 45 * Math.PI) / 180) * 18;

  return {
    t,
    coil_db: Math.round(coil * 100) / 100,
    nir: Math.round(nir * 10000) / 10000,
    imu: {
      pitch: Math.round((pitchBase + 1.2 * noise(t, 0.002, 5) + shake * 0.6 * noise(t, 0.02, 9)) * 10) / 10,
      roll: Math.round((smoothRoll + 1.4 * noise(t, 0.002, 7)) * 10) / 10,
    },
    spot: ctx.spot ?? 0,
    quality: ctx.quality,
  };
}

// ---- Device ring buffer (read by the charts every frame) ------------------

const CAP = 1024;
export const deviceBuffer = {
  t: new Float64Array(CAP),
  coil: new Float32Array(CAP),
  nir: new Float32Array(CAP),
  head: 0,
  size: 0,
  latest: null as DeviceSample | null,
  push(sample: DeviceSample) {
    this.t[this.head] = sample.t;
    this.coil[this.head] = sample.coil_db;
    this.nir[this.head] = sample.nir;
    this.head = (this.head + 1) % CAP;
    this.size = Math.min(CAP, this.size + 1);
    this.latest = sample;
  },
  clear() {
    this.head = 0;
    this.size = 0;
    this.latest = null;
  },
};
export const DEVICE_BUFFER_CAP = CAP;
