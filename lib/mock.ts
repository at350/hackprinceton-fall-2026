import type {
  BleedType,
  DeviceSample,
  RegionAgent,
  RegionName,
  ScanSpot,
  Simulation,
  SignalQuality,
} from "./types";

// ---- Head geometry --------------------------------------------------------
// Axial view from above, nose up, patient's left on screen left.
// Map coordinates: x, y in [-1, 1], y = -1 is the nose.

export const HEAD = { rx: 0.78, ry: 0.92 };
export const SCAN_GRID = 64;
export const SIM_GRID = 32;

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

function angDiff(a: number, b: number) {
  const d = Math.abs(a - b) % 360;
  return (d > 180 ? 360 - d : d) * (Math.PI / 180);
}

function grid(n: number, f: (x: number, y: number) => number): number[][] {
  const out: number[][] = [];
  for (let row = 0; row < n; row++) {
    const line: number[] = [];
    const y = (row / (n - 1)) * 2 - 1;
    for (let col = 0; col < n; col++) {
      const x = (col / (n - 1)) * 2 - 1;
      line.push(Math.round(f(x, y) * 1000) / 1000);
    }
    out.push(line);
  }
  return out;
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

// ---- Ground truth for the demo patient -----------------------------------
// Epidural hematoma, left temporal, ~22 mL.

const TRUTH = { type: "epidural" as BleedType, angle: 268, volume: 22 };

/** Smooth, low background "likelihood" so scanned tissue isn't flat. */
function background(x: number, y: number) {
  const v =
    Math.sin(x * 5.1 + 1.3) * Math.cos(y * 4.3 - 0.7) +
    0.6 * Math.sin((x + y) * 7.7 + 2.1) +
    0.4 * Math.cos(x * 11.3 - y * 3.1);
  return 0.09 + 0.05 * v;
}

/** Bleed shape for a hypothesis, 0-1, evaluated at (x, y). */
export function bleedShape(type: BleedType, angle: number, volume: number) {
  const s = Math.cbrt(volume / 20);
  return (x: number, y: number) => {
    const { r, a } = polar(x, y);
    if (r > 0.97) return 0;
    const da = angDiff(a, angle);
    switch (type) {
      case "epidural": {
        // Lens hugging the inner skull, short arc.
        const dr = (0.86 - r) / (0.09 * s);
        const dt = da / (0.32 * s);
        return Math.exp(-(dr * dr + dt * dt) / 2);
      }
      case "subdural": {
        // Thin crescent along the skull, long arc.
        const dr = (0.9 - r) / (0.045 * s);
        const dt = da / (0.62 * s);
        return Math.exp(-(dr * dr + dt * dt * dt * dt) / 2);
      }
      case "intraparenchymal": {
        const c = pointAt(angle, 0.5);
        const d = Math.hypot(x - c.x, y - c.y) / (0.14 * s);
        return Math.exp(-(d * d) / 2);
      }
    }
  };
}

const truthShape = bleedShape(TRUTH.type, TRUTH.angle, TRUTH.volume);

export function truthLikelihood(x: number, y: number) {
  const { r } = polar(x, y);
  if (r > 0.97) return 0;
  return Math.min(1, background(x, y) + 0.9 * truthShape(x, y));
}

/** Sensitivity of one scan spot at (x, y): strongest under the coil. */
function spotSensitivity(spot: number, x: number, y: number) {
  const p = pointAt(spot * 45);
  const d = Math.hypot(x - p.x, y - p.y);
  return Math.exp(-(d * d) / (2 * 0.5 * 0.5));
}

/** Cumulative 64x64 likelihood map over the finished spots. 0 = not scanned. */
export function scanMap(doneSpots: number[]): number[][] {
  return grid(SCAN_GRID, (x, y) => {
    const { r } = polar(x, y);
    if (r > 0.97) return 0;
    let cov = 0;
    for (const s of doneSpots) cov = Math.max(cov, spotSensitivity(s, x, y));
    const reveal = Math.min(1, Math.max(0, (cov - 0.18) / 0.35));
    return reveal * Math.max(0.07, truthLikelihood(x, y));
  });
}

const peakCache = new Map<number, number>();

/** Peak likelihood seen under one spot. */
export function spotPeak(spot: number) {
  const cached = peakCache.get(spot);
  if (cached !== undefined) return cached;
  let peak = 0;
  for (let i = 0; i < 24; i++) {
    for (let j = 0; j < 24; j++) {
      const x = (i / 23) * 2 - 1;
      const y = (j / 23) * 2 - 1;
      if (spotSensitivity(spot, x, y) > 0.6) peak = Math.max(peak, truthLikelihood(x, y));
    }
  }
  peak = Math.round(peak * 100) / 100;
  peakCache.set(spot, peak);
  return peak;
}

/** How much a spot sits over the bleed, 0-1. Drives the device signal. */
export function spotOverBleed(spot: number | null) {
  if (spot === null) return 0;
  return Math.max(0, (spotPeak(spot) - 0.25) / 0.7);
}

// ---- Simulations ----------------------------------------------------------

const REGION_ANGLE: Record<string, number> = {
  "L frontal": 325,
  "R frontal": 35,
  "L temporal": 268,
  "R temporal": 92,
  "L parietal": 222,
  "R parietal": 138,
  "L occipital": 192,
  "R occipital": 168,
};

interface Hypothesis {
  agent: RegionName;
  type: BleedType;
  region: string;
  volume_ml: number;
  score: number;
}

// Scores are scripted so the story is stable; best fit matches the truth.
const HYPOTHESES: Hypothesis[] = [
  { agent: "frontal", type: "subdural", region: "L frontal", volume_ml: 18, score: 0.41 },
  { agent: "frontal", type: "epidural", region: "R frontal", volume_ml: 15, score: 0.08 },
  { agent: "frontal", type: "intraparenchymal", region: "L frontal", volume_ml: 12, score: 0.29 },
  { agent: "frontal", type: "epidural", region: "L frontal", volume_ml: 20, score: 0.47 },
  { agent: "frontal", type: "subdural", region: "R frontal", volume_ml: 25, score: 0.06 },
  { agent: "frontal", type: "intraparenchymal", region: "R frontal", volume_ml: 8, score: 0.04 },

  { agent: "temporal", type: "subdural", region: "L temporal", volume_ml: 25, score: 0.84 },
  { agent: "temporal", type: "epidural", region: "R temporal", volume_ml: 20, score: 0.11 },
  { agent: "temporal", type: "intraparenchymal", region: "L temporal", volume_ml: 15, score: 0.71 },
  { agent: "temporal", type: "epidural", region: "L temporal", volume_ml: 22, score: 0.91 },
  { agent: "temporal", type: "epidural", region: "L temporal", volume_ml: 35, score: 0.76 },
  { agent: "temporal", type: "subdural", region: "R temporal", volume_ml: 18, score: 0.09 },

  { agent: "parietal", type: "subdural", region: "L parietal", volume_ml: 20, score: 0.63 },
  { agent: "parietal", type: "epidural", region: "L parietal", volume_ml: 14, score: 0.55 },
  { agent: "parietal", type: "intraparenchymal", region: "R parietal", volume_ml: 10, score: 0.05 },
  { agent: "parietal", type: "epidural", region: "R parietal", volume_ml: 24, score: 0.07 },
  { agent: "parietal", type: "intraparenchymal", region: "L parietal", volume_ml: 18, score: 0.44 },
  { agent: "parietal", type: "subdural", region: "R parietal", volume_ml: 30, score: 0.04 },

  { agent: "occipital", type: "subdural", region: "L occipital", volume_ml: 16, score: 0.32 },
  { agent: "occipital", type: "epidural", region: "R occipital", volume_ml: 12, score: 0.06 },
  { agent: "occipital", type: "intraparenchymal", region: "L occipital", volume_ml: 9, score: 0.18 },
  { agent: "occipital", type: "epidural", region: "L occipital", volume_ml: 18, score: 0.27 },
  { agent: "occipital", type: "subdural", region: "R occipital", volume_ml: 22, score: 0.05 },
  { agent: "occipital", type: "intraparenchymal", region: "R occipital", volume_ml: 6, score: 0.03 },
];

export const REGIONS: RegionName[] = ["frontal", "temporal", "parietal", "occipital"];

export function simMap(type: BleedType, region: string, volume: number) {
  const shape = bleedShape(type, REGION_ANGLE[region], volume);
  return grid(SIM_GRID, (x, y) => {
    const { r } = polar(x, y);
    if (r > 0.97) return 0;
    return Math.min(1, 0.06 + 0.92 * shape(x, y));
  });
}

export function initialSims(): Simulation[] {
  return HYPOTHESES.map((h, i) => ({
    id: `sim-${String(i + 1).padStart(2, "0")}`,
    type: h.type,
    region: h.region,
    volume_ml: h.volume_ml,
    status: "queued",
    score: h.score,
    map: simMap(h.type, h.region, h.volume_ml),
    agent: h.agent,
    progress: 0,
  }));
}

export function initialAgents(): RegionAgent[] {
  return REGIONS.map((region) => ({ region, done: 0, total: 6, state: "idle" }));
}

/** Duration of each simulation run, jittered but deterministic. */
export function simDuration(index: number) {
  return 3600 + ((index * 7919) % 1900);
}

// ---- Device stream --------------------------------------------------------

export interface DeviceContext {
  spot: number | null;
  moving: boolean; // between spots
  quality: SignalQuality;
}

// Deterministic noise so the stream looks the same each loop.
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

let smoothBleed = 0;
let smoothRoll = 0;

/** One ~50 Hz device sample at wall time t (ms). */
export function deviceSample(t: number, ctx: DeviceContext): DeviceSample {
  const s = t / 1000;
  const target = ctx.moving ? 0 : spotOverBleed(ctx.spot);
  smoothBleed += (target - smoothBleed) * 0.04;

  const shake = ctx.moving ? 1.6 : ctx.quality === "weak" ? 0.9 : 0.25;
  const coil =
    -38.2 +
    0.5 * Math.sin(s * 2 * Math.PI * 0.27) +
    shake * noise(t, 0.03, 11) +
    0.12 * (hash(t) * 2 - 1) -
    4.4 * smoothBleed;

  // NIR shows cardiac pulsation (~72 bpm) and respiration (~15/min).
  const beat = (s * 1.2) % 1;
  const pulse = Math.exp(-((beat - 0.15) ** 2) / 0.004) + 0.4 * Math.exp(-((beat - 0.42) ** 2) / 0.01);
  const nir =
    0.612 +
    0.028 * pulse +
    0.008 * Math.sin(s * 2 * Math.PI * 0.25) +
    (ctx.quality === "weak" ? 0.012 : 0.003) * noise(t, 0.05, 3) -
    0.07 * smoothBleed;

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
