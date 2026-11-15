// Model: the brain generated from this scan's signals. It starts as a smooth, see-through average head;
// each spot read folds the cortex under it into shape and makes it solid; regions swell or settle with their
// measured conductivity; hair grows with the measured hair and gap; blood shows where the fit puts it; and
// the whole brain beats with the pulse in the near-infrared light, live.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { setupControls, pct } from './controls.js';

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const R = 90;
const SWELL_MM_PER_SD = 3.0;   // regional swelling per standard deviation of conductivity (about 10x real)
const HAIR_SCALE = 3.0;        // hair drawn this many times longer than measured, to be visible
const N_HAIR = 5000;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const REGIONS = ['frontal', 'frontotemporal', 'temporal', 'parietal', 'occipital'];
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const RAMP_GLSL = `
vec3 bloodRamp(float t) {
  vec3 c0 = vec3(0.227, 0.055, 0.122), c1 = vec3(0.702, 0.141, 0.231);
  vec3 c2 = vec3(0.933, 0.420, 0.231), c3 = vec3(1.0, 0.827, 0.541);
  t = clamp(t, 0.0, 1.0);
  return t < 0.35 ? mix(c0, c1, t / 0.35) : t < 0.7 ? mix(c1, c2, (t - 0.35) / 0.35) : mix(c2, c3, (t - 0.7) / 0.3);
}`;

// Scene

const canvas = $('model-scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#0d1626');
const camera = new THREE.PerspectiveCamera(32, 1, 1, 3000);
camera.up.set(0, 0, 1);
camera.position.set(-330, 300, 160);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.enablePan = false;
controls.autoRotate = !REDUCED;
controls.autoRotateSpeed = 0.5;
controls.minDistance = 220;
controls.maxDistance = 900;
controls.addEventListener('start', () => { controls.autoRotate = false; });
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(512, 512), 0.65, 0.5, 0.66));
composer.addPass(new OutputPass());
scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x1a0f1a, 0.8));
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(-200, 260, 320);
scene.add(key);
const rim = new THREE.DirectionalLight(0x6fb7f0, 1.0);
rim.position.set(260, -300, 60);
scene.add(rim);

// The scalp: glass, with the ear line and midline for reference.
scene.add(new THREE.Mesh(new THREE.SphereGeometry(R, 96, 64), new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }',
  fragmentShader: 'varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 2.6); gl_FragColor = vec4(vec3(0.38,0.65,0.9) * (0.02 + 0.45*f), 1.0); }',
})));
const nose = new THREE.Mesh(new THREE.ConeGeometry(7, 18, 24), new THREE.MeshStandardMaterial({ color: 0x3a5c8c, transparent: true, opacity: 0.7 }));
nose.position.set(0, R + 6, -6);
nose.rotation.x = -Math.PI / 2;
scene.add(nose);

// The brain

const uniforms = { uPulse: { value: 0 } };
let brain = null;   // { attrs: {grow, swell, heat}, current/target arrays, dirs, n }

async function loadBrain() {
  const data = await (await fetch('brain.json')).json();
  const sulcDark = new THREE.Color('#3b4862'), gyrus = new THREE.Color('#c2cde0');
  const parts = [];
  let total = 0;
  for (const side of ['left', 'right']) {
    const h = data[side];
    const n = h.sulc.length;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(h.vertices, 3));
    geo.setIndex(h.faces);
    geo.computeVertexNormals();
    const normalsOf = (verts) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      g.setIndex(h.faces);
      g.computeVertexNormals();
      return g.attributes.normal;
    };
    geo.setAttribute('aInfl', new THREE.Float32BufferAttribute(h.inflated, 3));
    geo.setAttribute('aBlob', new THREE.Float32BufferAttribute(h.blob, 3));
    geo.setAttribute('nInfl', normalsOf(h.inflated));
    geo.setAttribute('nBlob', normalsOf(h.blob));
    const colors = new Float32Array(n * 3), c = new THREE.Color();
    h.sulc.forEach((sv, i) => { c.copy(gyrus).lerp(sulcDark, Math.pow(sv, 1.2)); colors.set([c.r, c.g, c.b], i * 3); });
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const seed = new Float32Array(n).map(() => Math.random());
    geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    const dyn = {};
    for (const name of ['grow', 'swell', 'heat']) {
      dyn[name] = new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, dyn[name]);
    }
    parts.push({ geo, n, offset: total, dyn, verts: h.vertices });
    total += n;
  }
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.02, transparent: true });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aInfl; attribute vec3 aBlob; attribute vec3 nInfl; attribute vec3 nBlob;
attribute float grow; attribute float swell; attribute float heat; attribute float seed;
uniform float uPulse;
varying float vGrow; varying float vHeat; varying float vSwell;`)
      .replace('#include <beginnormal_vertex>', `
float g = clamp(grow * 1.15 - seed * 0.15, 0.0, 1.0);
vec3 objectNormal = g < 0.5 ? normalize(mix(nBlob, nInfl, g * 2.0)) : normalize(mix(nInfl, normal, g * 2.0 - 1.0));`)
      .replace('#include <begin_vertex>', `
vec3 transformed = g < 0.5 ? mix(aBlob, aInfl, g * 2.0) : mix(aInfl, position, g * 2.0 - 1.0);
transformed += objectNormal * swell;
transformed *= 1.0 + uPulse * 0.01;
vGrow = g; vHeat = heat; vSwell = swell;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vGrow; varying float vHeat; varying float vSwell;\n${RAMP_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
vec3 holo = vec3(0.30, 0.55, 0.85);
diffuseColor.rgb = mix(holo * 0.75, diffuseColor.rgb, smoothstep(0.1, 0.9, vGrow));
diffuseColor.rgb = mix(diffuseColor.rgb, vSwell > 0.0 ? vec3(0.95, 0.62, 0.45) : vec3(0.45, 0.62, 0.9), min(abs(vSwell) / 7.0, 0.4) * vGrow);
diffuseColor.rgb = mix(diffuseColor.rgb, bloodRamp(vHeat) * 0.55, smoothstep(0.04, 0.6, vHeat) * 0.85);
diffuseColor.a = mix(0.5, 1.0, smoothstep(0.55, 0.95, vGrow));`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
float fres = pow(1.0 - abs(dot(normalize(vViewPosition), normal)), 2.2);
totalEmissiveRadiance += vec3(0.30, 0.55, 0.85) * (0.12 + fres * 1.4) * (1.0 - vGrow);
totalEmissiveRadiance += vec3(0.44, 0.72, 0.94) * (1.0 - smoothstep(0.0, 0.18, abs(vGrow - 0.6))) * 0.7;
totalEmissiveRadiance += bloodRamp(vHeat) * smoothstep(0.05, 0.9, vHeat) * 0.8;`);
  };
  const group = new THREE.Group();
  for (const p of parts) group.add(new THREE.Mesh(p.geo, mat));
  scene.add(group);

  const dirs = new Float32Array(total * 3);
  for (const p of parts) {
    for (let i = 0; i < p.n; i++) {
      const x = p.verts[i * 3], y = p.verts[i * 3 + 1], z = p.verts[i * 3 + 2], r = Math.hypot(x, y, z) || 1;
      dirs.set([x / r, y / r, z / r], (p.offset + i) * 3);
    }
  }
  const state = (name) => ({ current: new Float32Array(total), target: new Float32Array(total), name });
  brain = { parts, dirs, total, grow: state('grow'), swell: state('swell'), heat: state('heat') };
}

function flush(field, rate) {
  let changed = false;
  const { current, target } = field;
  for (let i = 0; i < current.length; i++) {
    const d = target[i] - current[i];
    if (Math.abs(d) > 0.002) { current[i] += REDUCED ? d : d * rate; changed = true; }
  }
  if (changed) {
    for (const p of brain.parts) {
      p.dyn[field.name].array.set(current.subarray(p.offset, p.offset + p.n));
      p.dyn[field.name].needsUpdate = true;
    }
  }
}

// Hair: strands on the scalp, as long as the measured hair and gap at the nearest spot.

const hair = (() => {
  const pos = new Float32Array(N_HAIR * 6), base = [], spotIdx = new Int16Array(N_HAIR);
  const len = { current: new Float32Array(N_HAIR), target: new Float32Array(N_HAIR) };
  for (let i = 0; i < N_HAIR; i++) {
    let d;
    do { d = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1); } while (d.lengthSq() > 1 || d.lengthSq() < 0.01);
    d.normalize();
    if (d.z < -0.25 || (d.y > 0.55 && d.z < 0.55)) { i--; continue; }  // no hair on the face or below the ears
    d.x += (Math.random() - 0.5) * 0.04;
    base.push(d.normalize());
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x9fb3cf, transparent: true, opacity: 0.45 }));
  scene.add(lines);
  return { pos, base, spotIdx, len, geo };
})();

let spots = [];      // [{id, side, region, dir}]
let spotState = {};  // id -> {sigma, gap, ...}
let tissueRef = { sigma: 0.25, sd: 0.04 };

function assignHair() {
  for (let i = 0; i < N_HAIR; i++) {
    let best = 0, bestDot = -2;
    spots.forEach((s, k) => { const d = hair.base[i].dot(s.dir); if (d > bestDot) { bestDot = d; best = k; } });
    hair.spotIdx[i] = best;
  }
}

// Building the head from the readings

function rebuild(final) {
  if (!brain) return;
  const done = spots.filter((s) => spotState[s.id]);
  const ok = done.filter((s) => spotState[s.id].sigma != null);
  const { dirs, total } = brain;
  for (let i = 0; i < total; i++) {
    const dx = dirs[i * 3], dy = dirs[i * 3 + 1], dz = dirs[i * 3 + 2];
    let grow = 0, wSum = 0, zSum = 0;
    for (const s of done) grow = Math.max(grow, smooth(0.35, 0.65, dx * s.dir.x + dy * s.dir.y + dz * s.dir.z));
    for (const s of ok) {
      const c = Math.min(1, Math.max(-1, dx * s.dir.x + dy * s.dir.y + dz * s.dir.z));
      const a = Math.acos(c);
      const w = Math.exp(-(a * a) / (2 * 0.45 * 0.45));
      const z = Math.max(-3, Math.min(3, (spotState[s.id].sigma - tissueRef.sigma) / tissueRef.sd));
      wSum += w; zSum += w * z;
    }
    brain.grow.target[i] = final ? 1 : grow;
    brain.swell.target[i] = SWELL_MM_PER_SD * zSum / (wSum + 0.15);
  }
  for (let i = 0; i < N_HAIR; i++) {
    const s = spotState[spots[hair.spotIdx[i]]?.id];
    hair.len.target[i] = s && s.gap != null ? Math.max(0, s.gap) * HAIR_SCALE * (0.75 + 0.5 * ((i * 7919) % 100) / 100) : 0;
  }
}

function hello(h) {
  spots = h.spots.map((s) => ({ ...s, dir: new THREE.Vector3(...s.pos).normalize() }));
  spotState = {};
  tissueRef = { sigma: h.tissue_sigma ?? 0.25, sd: h.region_sd ?? 0.04 };
  scanInfo = { label: h.label, speed: h.speed || 1 };
  $('scan-label').textContent = h.label;
  assignHair();
  if (brain) brain.heat.target.fill(0);
  rebuild(false);
  $('model-phase').textContent = 'An average head, before any reading. Each spot the probe reads makes the region under it this person\'s.';
  $('model-built').textContent = 'Nothing read yet. Each spot the probe reads shapes the region under it.';
  $('bpm').textContent = '–';
  $('bpm-note').textContent = 'waiting for skin contact';
  $('model-blood').textContent = 'No reading yet.';
  captured = false;
  sawLive = false;
  renderTissue();
}

function update(u) {
  for (const row of u.spots) spotState[row.spot] = { sigma: row.sigma, se: row.sigma_se, gap: row.gap_mm, od: row.od, status: row.status, pulse: row.pulse_bpm };
  rebuild(u.final);
  if (brain) setHeat(u.cortex);
  const n = Object.keys(spotState).length;
  const bpms = Object.values(spotState).map((s) => s.pulse).filter((v) => v != null);
  const bpm = u.heart_rate_bpm ?? (bpms.length ? bpms.sort((a, b) => a - b)[Math.floor(bpms.length / 2)] : null);
  if (bpm != null) { $('bpm').textContent = Math.round(bpm); $('bpm-note').textContent = u.final ? 'median over the scan' : `from ${bpms.length} spot${bpms.length === 1 ? '' : 's'} so far`; }
  $('model-built').textContent = u.final
    ? 'All ten spots read. Every region of this model now comes from this head\'s readings.'
    : `${n} of 10 spots read. The solid, folded parts come from this head; the see-through parts are still the average.`;
  $('model-phase').textContent = u.final
    ? 'This head, from its signals: its tissue pattern, hair, pulse and blood.'
    : `Shaping the region under ${u.done[u.done.length - 1].replace('-', ' ')}.`;
  $('model-blood').textContent = u.pairs_done
    ? `${pct(u.p_bleed)} chance of a bleed. ${u.location && u.location.status !== 'none' ? u.location.text : 'Left and right match so far.'}`
    : 'Needs a finished left/right pair.';
  renderTissue();
  if (!u.final) sawLive = true;
  // Only snapshot a scan this page watched; a page opened afterwards just gets the last update replayed.
  if (u.final && sawLive && !captured) { captured = true; setTimeout(capture, REDUCED ? 200 : 3200); }
}

function setHeat(b64) {
  const bin = atob(b64);
  for (let i = 0; i < brain.heat.target.length; i++) brain.heat.target[i] = bin.charCodeAt(i) / 255;
}

// Tissue table: per region, each side's conductivity against a typical head, and the hair and gap.

function renderTissue() {
  const body = $('tissue').querySelector('tbody');
  const bar = (s) => {
    if (!s || s.sigma == null) return '<span class="muted">not read</span>';
    const z = Math.max(-3, Math.min(3, (s.sigma - tissueRef.sigma) / tissueRef.sd));
    const x0 = 50, w = Math.abs(z) / 3 * 46, x = z >= 0 ? x0 : x0 - w;
    const col = z >= 0 ? css('--blood-2') : css('--cool');
    return `<svg viewBox="0 0 100 14" preserveAspectRatio="none" role="img" aria-label="${s.sigma.toFixed(3)} siemens per metre">`
      + `<line x1="50" x2="50" y1="0" y2="14" stroke="${css('--ink-3')}" stroke-width="1"/>`
      + `<rect x="${x}" y="3" width="${Math.max(w, 1)}" height="8" rx="2" fill="${col}"/></svg>`
      + `<span class="muted">${s.sigma.toFixed(2)}</span>`;
  };
  body.innerHTML = REGIONS.map((r) => {
    const L = spotState[`L-${r}`], Rr = spotState[`R-${r}`];
    const hairTxt = (s) => (s && s.gap != null ? s.gap.toFixed(1) : '–');
    return `<tr><td>${r[0].toUpperCase() + r.slice(1)}</td><td>${bar(L)}</td><td>${bar(Rr)}</td><td>${hairTxt(L)} / ${hairTxt(Rr)} mm</td></tr>`;
  }).join('');
}

// Live pulse: the near-infrared signal's fast part, played back at the scan's pace.

const pulse = { queue: [], ema: null, amp: 0.002, trace: [], onHead: false, carry: 0 };
let scanInfo = { label: '', speed: 1 };

function frames(f) {
  pulse.onHead = !!(f.status && f.status.on_head);
  for (const v of f.nir) {
    pulse.ema = pulse.ema == null ? v : pulse.ema + (v - pulse.ema) * 0.03;
    const ac = v - pulse.ema;
    pulse.amp += (Math.abs(ac) - pulse.amp) * 0.01;
    pulse.queue.push(pulse.onHead ? ac / Math.max(pulse.amp * 2.5, 1e-4) : 0);
  }
  if (pulse.queue.length > 2000) pulse.queue.splice(0, pulse.queue.length - 2000);
}

function stepPulse(dt) {
  pulse.carry += dt * 100 * scanInfo.speed;
  let n = Math.floor(pulse.carry);
  pulse.carry -= n;
  let v = null;
  while (n-- > 0 && pulse.queue.length) { v = pulse.queue.shift(); pulse.trace.push(v); }
  if (pulse.trace.length > 400) pulse.trace.splice(0, pulse.trace.length - 400);
  const target = v == null ? 0 : Math.max(-1.2, Math.min(1.2, v));
  uniforms.uPulse.value += (target - uniforms.uPulse.value) * 0.5;
  drawTrace();
}

const traceCanvas = $('pulse-trace');
function drawTrace() {
  const r = traceCanvas.getBoundingClientRect();
  if (traceCanvas.width !== Math.round(r.width * devicePixelRatio)) {
    traceCanvas.width = r.width * devicePixelRatio;
    traceCanvas.height = r.height * devicePixelRatio;
  }
  const ctx = traceCanvas.getContext('2d');
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  ctx.strokeStyle = css('--line');
  ctx.beginPath(); ctx.moveTo(0, r.height / 2); ctx.lineTo(r.width, r.height / 2); ctx.stroke();
  ctx.strokeStyle = css('--blood-2');
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  const tr = pulse.trace;
  for (let i = 0; i < tr.length; i++) {
    const x = (i / 399) * r.width, y = r.height / 2 - Math.max(-1.3, Math.min(1.3, tr[i])) * r.height * 0.36;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// Previous heads

let captured = false, sawLive = false;
const GALLERY_KEY = 'lucid-previous-heads';

function addToGallery({ src, label, detail }) {
  const li = document.createElement('li');
  const img = new Image();
  img.src = src;
  img.alt = `Head model for ${label}`;
  const p = document.createElement('p');
  p.innerHTML = `<b></b>`;
  p.firstChild.textContent = label;
  p.append(detail);
  li.append(img, p);
  $('gallery').prepend(li);
  $('gallery-empty').hidden = true;
}

function capture() {
  composer.render();
  const bpm = $('bpm').textContent;
  const entry = {
    src: canvas.toDataURL('image/jpeg', 0.8), label: scanInfo.label,
    detail: `${bpm !== '–' ? `${bpm} bpm, ` : ''}${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
  };
  addToGallery(entry);
  try {  // keep the last six across reloads; fine to lose if storage is unavailable
    const saved = JSON.parse(localStorage.getItem(GALLERY_KEY) || '[]');
    localStorage.setItem(GALLERY_KEY, JSON.stringify([...saved, entry].slice(-6)));
  } catch { /* private window or full storage */ }
}

try { JSON.parse(localStorage.getItem(GALLERY_KEY) || '[]').forEach(addToGallery); } catch { /* nothing saved */ }

// Loop

function resize() {
  const el = canvas.parentElement, w = el.clientWidth, h = el.clientHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  camera.position.setLength(480 * Math.max(1, 1.05 / camera.aspect));
}
new ResizeObserver(resize).observe(canvas.parentElement);

let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (brain) {
    flush(brain.grow, 0.03);
    flush(brain.swell, 0.04);
    flush(brain.heat, 0.05);
  }
  let hairChanged = false;
  for (let i = 0; i < N_HAIR; i++) {
    const d = hair.len.target[i] - hair.len.current[i];
    if (Math.abs(d) > 0.01) { hair.len.current[i] += REDUCED ? d : d * 0.05; hairChanged = true; }
  }
  if (hairChanged) {
    for (let i = 0; i < N_HAIR; i++) {
      const b = hair.base[i], l = hair.len.current[i];
      hair.pos.set([b.x * (R + 0.4), b.y * (R + 0.4), b.z * (R + 0.4), b.x * (R + 0.4 + l), b.y * (R + 0.4 + l), b.z * (R + 0.4 + l)], i * 6);
    }
    hair.geo.attributes.position.needsUpdate = true;
  }
  stepPulse(dt);
  controls.update();
  composer.render();
});

setupControls();
renderTissue();
loadBrain().then(() => {
  resize();
  const events = new EventSource('/events');
  events.addEventListener('hello', (ev) => hello(JSON.parse(ev.data)));
  events.addEventListener('frames', (ev) => frames(JSON.parse(ev.data)));
  events.addEventListener('update', (ev) => update(JSON.parse(ev.data)));
});
