// Sixteen heads: sixteen of the 500 simulated heads, each a brain of its own. They are built up from the
// readings (each finished spot materialises the cortex it can see), each shows where its own bleed would be,
// and at the end they fly together and resolve into the merged map from all 500.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { setupControls, pct } from './controls.js';

const $ = (id) => document.getElementById(id);
const N = 16, COLS = 4;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const FROST = new THREE.Color('#6fb7f0');
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const RAMP_GLSL = `
vec3 bloodRamp(float t) {
  vec3 c0 = vec3(0.227, 0.055, 0.122), c1 = vec3(0.702, 0.141, 0.231);
  vec3 c2 = vec3(0.933, 0.420, 0.231), c3 = vec3(1.0, 0.827, 0.541);
  t = clamp(t, 0.0, 1.0);
  return t < 0.35 ? mix(c0, c1, t / 0.35) : t < 0.7 ? mix(c1, c2, (t - 0.35) / 0.35) : mix(c2, c3, (t - 0.7) / 0.3);
}`;

// Scene

const canvas = $('ens-scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#0d1626');
const camera = new THREE.PerspectiveCamera(30, 1, 10, 8000);
camera.up.set(0, 0, 1);
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(512, 512), 0.6, 0.45, 0.7));
composer.addPass(new OutputPass());
scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x1a0f1a, 0.8));
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(-300, -500, 400);
scene.add(key);
const rim = new THREE.DirectionalLight(0x6fb7f0, 1.0);
rim.position.set(400, 400, 100);
scene.add(rim);

const shared = {
  uTime: { value: 0 },
  uActive: { value: new THREE.Vector3(0, 0, 1) },
  uActiveOn: { value: 0 },
};
const SPACE_X = 200, SPACE_Z = 185;
const gridPos = (i) => new THREE.Vector3(((i % COLS) - (COLS - 1) / 2) * SPACE_X, 0, ((COLS - 1) / 2 - Math.floor(i / COLS)) * SPACE_Z + 20);
const GRID_W = COLS * SPACE_X, GRID_H = COLS * SPACE_Z;
const MERGED_SCALE = (GRID_H * 0.5) / 130;
const MERGED_AT = new THREE.Vector3(0, 0, -60);  // a little low, under the title

function brainMaterial(lag) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.02, transparent: true });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, { uLag: lag });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float heat; attribute float reveal; attribute float seed;\nvarying float vHeat; varying float vReveal; varying float vSeed; varying vec3 vDir;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHeat = heat; vReveal = reveal; vSeed = seed; vDir = normalize(position);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uTime; uniform vec3 uActive; uniform float uActiveOn; uniform float uLag;
varying float vHeat; varying float vReveal; varying float vSeed; varying vec3 vDir;
${RAMP_GLSL}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
float built = vReveal - (vSeed * 0.92 + 0.04) - uLag;
if (built < 0.0) discard;`)
      .replace('#include <color_fragment>',
        '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, bloodRamp(vHeat) * 0.55, smoothstep(0.04, 0.6, vHeat) * 0.85);')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
float edge = 1.0 - smoothstep(0.0, 0.035, built);
totalEmissiveRadiance += vec3(0.44, 0.72, 0.94) * edge * 1.1;
totalEmissiveRadiance += bloodRamp(vHeat) * smoothstep(0.05, 0.9, vHeat) * 0.7;
float near = smoothstep(0.82, 0.98, dot(vDir, uActive)) * uActiveOn;
totalEmissiveRadiance += vec3(0.44, 0.72, 0.94) * near * (0.35 + 0.35 * sin(uTime * 7.0 + vSeed * 40.0));`);
  };
  return mat;
}

function ghostMaterial(lag, opacity) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { ...shared, uLag: lag, uOpacity: opacity },
    vertexShader: `attribute float reveal; attribute float seed; uniform float uTime; uniform float uLag;
      varying float vA;
      void main() {
        float built = reveal - (seed * 0.92 + 0.04) - uLag;
        vA = (built < 0.0 ? 1.0 : 0.0) * (0.35 + 0.35 * sin(uTime * 2.0 + seed * 60.0));
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = 1.6 * (900.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `uniform float uOpacity; varying float vA;
      void main() { float d = length(gl_PointCoord - 0.5); if (vA <= 0.0 || d > 0.5) discard;
        gl_FragColor = vec4(vec3(0.30, 0.55, 0.85) * vA * 0.45 * uOpacity, 1.0); }`,
  });
}

const tiles = [];
let merged = null;
let brainDirs = null;  // unit direction of each cortex vertex, left then right
let reveal = null;     // shared build state: current and target per vertex
const hemis = [];

async function loadBrain() {
  const data = await (await fetch('brain.json')).json();
  const sulcDark = new THREE.Color('#3b4862'), gyrus = new THREE.Color('#c2cde0');
  let total = 0;
  for (const side of ['left', 'right']) {
    const h = data[side];
    const base = new THREE.BufferGeometry();
    base.setAttribute('position', new THREE.Float32BufferAttribute(h.vertices, 3));
    base.setIndex(h.faces);
    base.computeVertexNormals();
    const n = h.sulc.length;
    const colors = new Float32Array(n * 3), seeds = new Float32Array(n);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      c.copy(gyrus).lerp(sulcDark, Math.pow(h.sulc[i], 1.2));
      colors.set([c.r, c.g, c.b], i * 3);
      seeds[i] = Math.random();
    }
    const revealAttr = new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
    hemis.push({ base, n, offset: total, color: new THREE.BufferAttribute(colors, 3), seed: new THREE.BufferAttribute(seeds, 1), reveal: revealAttr });
    total += n;
  }
  brainDirs = new Float32Array(total * 3);
  for (const h of hemis) {
    const p = h.base.attributes.position.array;
    for (let i = 0; i < h.n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2], r = Math.hypot(x, y, z) || 1;
      brainDirs.set([x / r, y / r, z / r], (h.offset + i) * 3);
    }
  }
  reveal = { current: new Float32Array(total), target: new Float32Array(total) };

  const makeBrain = (ownReveal) => {
    const group = new THREE.Group();
    const lag = { value: 0 }, opacity = { value: 1 };
    const heat = { current: new Float32Array(total), target: new Float32Array(total), attrs: [] };
    const meshes = [], ghosts = [];
    const mat = brainMaterial(lag);
    const gmat = ghostMaterial(lag, opacity);
    for (const h of hemis) {
      const geo = new THREE.BufferGeometry();
      for (const name of ['position', 'normal']) geo.setAttribute(name, h.base.attributes[name]);
      geo.setIndex(h.base.index);
      geo.setAttribute('color', h.color);
      geo.setAttribute('seed', h.seed);
      geo.setAttribute('reveal', ownReveal ? new THREE.BufferAttribute(new Float32Array(h.n).fill(1), 1) : h.reveal);
      const heatAttr = new THREE.BufferAttribute(new Float32Array(h.n), 1).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('heat', heatAttr);
      heat.attrs.push(heatAttr);
      const mesh = new THREE.Mesh(geo, mat);
      group.add(mesh);
      meshes.push(mesh);
      if (!ownReveal) {
        const pts = new THREE.Points(geo, gmat);
        group.add(pts);
        ghosts.push(pts);
      }
    }
    scene.add(group);
    return { group, lag, opacity, heat, mat, gmat, meshes, ghosts, lagStart: 0 };
  };
  for (let i = 0; i < N; i++) {
    const t = makeBrain(false);
    t.home = gridPos(i);
    t.group.position.copy(t.home);
    t.label = document.createElement('div');
    t.label.innerHTML = `<b>${i + 1}</b><span>Waiting for readings</span>`;
    $('ens-labels').appendChild(t.label);
    tiles.push(t);
  }
  merged = makeBrain(true);
  merged.group.scale.setScalar(MERGED_SCALE);
  merged.group.position.copy(MERGED_AT);
  merged.opacity.value = 0;
  resize();
}

// State from the server

let spots = new Map();
let last = null;
let mergeT = 0, mergeDir = 0, autoMergeAt = null;

function setTarget(arr, b64) {
  if (!b64) { arr.fill(0); return; }
  const bin = atob(b64);
  for (let i = 0; i < arr.length; i++) arr[i] = bin.charCodeAt(i) / 255;
}

function rebuildReveal(done, final) {
  if (!reveal) return;
  const dirs = [...new Set(done)].map((id) => spots.get(id)).filter(Boolean);
  for (let i = 0; i < reveal.target.length; i++) {
    if (final) { reveal.target[i] = 1.02; continue; }
    let v = 0;
    const dx = brainDirs[i * 3], dy = brainDirs[i * 3 + 1], dz = brainDirs[i * 3 + 2];
    for (const d of dirs) v = Math.max(v, smooth(0.42, 0.62, dx * d.x + dy * d.y + dz * d.z));  // a patch about 55° across
    reveal.target[i] = v * 1.02;
  }
}

function hello(h) {
  spots = new Map(h.spots.map((s) => [s.id, new THREE.Vector3(...s.pos).normalize()]));
  $('scan-label').textContent = h.label;
  last = null;
  if (reveal) { reveal.target.fill(0); }
  for (const t of tiles) {
    t.heat.target.fill(0);
    t.label.className = '';
    t.label.innerHTML = `<b>${tiles.indexOf(t) + 1}</b><span>Waiting for readings</span>`;
  }
  if (merged) merged.heat.target.fill(0);
  split(true);
  $('ens-p').textContent = pct(h.prevalence);
  $('ens-progress').textContent = 'no spots read';
  $('ens-caption').textContent = 'Each brain is one simulated head that could explain the readings. Every finished spot builds the part of the cortex it can see, on all sixteen. At the end they merge into one map.';
}

function frames(f) {
  const s = f.status;
  if (s && s.on_head && spots.has(s.spot)) {
    shared.uActive.value.copy(spots.get(s.spot));
    shared.uActiveOn.value = 1;
  } else {
    shared.uActiveOn.value = 0;
  }
}

function update(u) {
  last = u;
  const now = clock.elapsedTime;
  rebuildReveal(u.done, u.final);
  tiles.forEach((t, i) => {
    const tile = (u.tiles || [])[i];
    if (!tile) return;
    setTarget(t.heat.target, tile.cortex);
    t.lagStart = now + i * 0.09;
    t.label.className = tile.bleed ? 'bleed' : 'clear';
    const [where, ...detail] = tile.label.split(', ');
    t.label.innerHTML = `<b>${i + 1}</b>${where}<span>${detail.length ? `, ${detail.join(', ')}` : ''}</span>`;
  });
  if (merged) setTarget(merged.heat.target, u.cortex);
  const nDone = new Set(u.done).size;
  const nBleed = (u.tiles || []).filter((t) => t.bleed).length;
  $('ens-p').textContent = pct(u.p_bleed);
  $('ens-p').parentElement.className = `ens-chance ${u.p_bleed >= 0.8 ? 'likely' : u.p_bleed >= 0.3 ? 'possible' : ''}`;
  $('ens-progress').textContent = u.final ? 'scan complete' : `${nDone} of 10 spots read`;
  if (mergeDir <= 0) {
    $('ens-caption').textContent = u.final
      ? 'Scan complete. Merging the heads into one map.'
      : `${nBleed} of these 16 heads put a bleed somewhere; across all 500 the chance is ${pct(u.p_bleed)}. Each finished spot builds more of every brain.`;
  }
  $('ens-merged-text').textContent = u.location && u.location.status !== 'none' && u.location.text
    ? u.location.text : 'No bleed-like pattern: the left and right sides match.';
  if (u.final) autoMergeAt = now + (REDUCED ? 0 : 1.8);
}

function merge() {
  if (!merged) return;
  mergeDir = 1;
  autoMergeAt = null;
  $('ens-merge').hidden = true;
  $('ens-split').hidden = false;
  $('ens-caption').textContent = 'The merged map is the average over all 500 simulated heads, not just these sixteen: where many heads agree, the chance of blood is high.';
}

function split(instant = false) {
  mergeDir = -1;
  if (instant) mergeT = 0;
  $('ens-merged').hidden = true;
  $('ens-merge').hidden = false;
  $('ens-split').hidden = true;
}

$('ens-merge').addEventListener('click', merge);
$('ens-split').addEventListener('click', () => split());

// Frame loop

const clock = new THREE.Clock();
let fit = 1;

function resize() {
  const el = canvas.parentElement;
  const w = el.clientWidth, h = el.clientHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  // Centre the grid in the space above the bottom bar.
  const hudH = Math.min(document.querySelector('.ens-hud').offsetHeight, h * 0.45);
  camera.setViewOffset(w, h, 0, hudH / 2, w, h);
  camera.updateProjectionMatrix();
  const vfov = THREE.MathUtils.degToRad(camera.fov);
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  const usableH = (h - hudH) / Math.max(h, 1);
  fit = Math.max((GRID_W / 2) / Math.tan(hfov / 2), (GRID_H / 2) / Math.tan(vfov / 2) / usableH) * 1.08;
}
new ResizeObserver(resize).observe(canvas.parentElement);
new ResizeObserver(resize).observe(document.querySelector('.ens-hud'));

function lerpHeat(heat) {
  let changed = false;
  for (let i = 0; i < heat.current.length; i++) {
    const d = heat.target[i] - heat.current[i];
    if (Math.abs(d) > 0.003) { heat.current[i] += d * 0.06; changed = true; }
  }
  if (changed) {
    heat.attrs.forEach((attr, k) => {
      attr.array.set(heat.current.subarray(hemis[k].offset, hemis[k].offset + attr.count));
      attr.needsUpdate = true;
    });
  }
}

renderer.setAnimationLoop(() => {
  const t = clock.getElapsedTime();
  shared.uTime.value = t;
  const spin = REDUCED ? -0.9 : -0.9 + t * 0.22;
  camera.position.set(Math.sin(t * 0.07) * fit * 0.05, -fit, fit * 0.08);
  camera.lookAt(0, 0, -30);

  if (reveal) {
    let changed = false;
    for (let i = 0; i < reveal.current.length; i++) {
      const d = reveal.target[i] - reveal.current[i];
      if (Math.abs(d) > 0.002) { reveal.current[i] += d * (REDUCED ? 1 : 0.04); changed = true; }
    }
    if (changed) {
      for (const h of hemis) { h.reveal.array.set(reveal.current.subarray(h.offset, h.offset + h.n)); h.reveal.needsUpdate = true; }
    }
  }

  if (autoMergeAt != null && t >= autoMergeAt) merge();
  if (mergeDir) {
    mergeT = Math.min(1, Math.max(0, mergeT + mergeDir * (REDUCED ? 1 : 1 / 60 / 3.2)));
    if ((mergeDir > 0 && mergeT >= 1) || (mergeDir < 0 && mergeT <= 0)) {
      if (mergeDir > 0) $('ens-merged').hidden = false;
      mergeDir = 0;
    }
  }
  const e = ease(mergeT);
  tiles.forEach((tile, i) => {
    // Each brain finishes building a beat after the one before it.
    tile.lag.value = 0.3 * (1 - smooth(tile.lagStart, tile.lagStart + 1.4, t));
    const p = tile.home.clone().lerp(MERGED_AT, e);
    p.y -= Math.sin(Math.PI * e) * 260;
    tile.group.position.copy(p);
    tile.group.scale.setScalar(1 + (MERGED_SCALE - 1) * e);
    tile.group.rotation.z = spin;
    const op = (mergeT < 0.25 ? 1 : 1 - 0.8 * smooth(0.25, 0.7, mergeT)) * (1 - smooth(0.8, 1, mergeT));
    tile.mat.opacity = op;
    tile.mat.depthWrite = op > 0.95;
    tile.gmat.uniforms.uOpacity.value = op;
    tile.group.visible = op > 0.005;
    lerpHeat(tile.heat);
    const lp = tile.home.clone().add(new THREE.Vector3(0, 0, -78)).project(camera);
    tile.label.style.left = `${((lp.x + 1) / 2) * canvas.clientWidth}px`;
    tile.label.style.top = `${((1 - lp.y) / 2) * canvas.clientHeight}px`;
    tile.label.style.opacity = 1 - smooth(0, 0.25, mergeT);
  });
  if (merged) {
    const op = smooth(0.6, 1, mergeT);
    merged.mat.opacity = op;
    merged.mat.depthWrite = op > 0.95;
    merged.group.visible = op > 0.005;
    merged.group.rotation.z = spin;
    lerpHeat(merged.heat);
  }
  composer.render();
});

setupControls();
window.lucidEnsemble = { tiles, get merged() { return merged; } };  // for poking at in the console
loadBrain().then(() => {
  const events = new EventSource('/events');
  events.addEventListener('hello', (ev) => hello(JSON.parse(ev.data)));
  events.addEventListener('frames', (ev) => frames(JSON.parse(ev.data)));
  events.addEventListener('update', (ev) => update(JSON.parse(ev.data)));
});
