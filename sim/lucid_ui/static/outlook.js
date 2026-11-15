// What if: one bleed, four ways it could go over the next 12 hours. Each lane is the same set of random runs
// under different conditions; the brains, the clock and the three charts all follow one playhead.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { tooltip } from './charts.js';

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const NS = 'http://www.w3.org/2000/svg';
const LANES = 4, SPACE = 190, HOURS = 12;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const REGIONS = ['frontal', 'frontotemporal', 'temporal', 'parietal', 'occipital'];
const laneColor = (i) => css(`--lane-${i + 1}`);
const RAMP_GLSL = `
vec3 bloodRamp(float t) {
  vec3 c0 = vec3(0.227, 0.055, 0.122), c1 = vec3(0.702, 0.141, 0.231);
  vec3 c2 = vec3(0.933, 0.420, 0.231), c3 = vec3(1.0, 0.827, 0.541);
  t = clamp(t, 0.0, 1.0);
  return t < 0.35 ? mix(c0, c1, t / 0.35) : t < 0.7 ? mix(c1, c2, (t - 0.35) / 0.35) : mix(c2, c3, (t - 0.7) / 0.3);
}`;
const interp = (xs, ys, x) => {
  if (x <= xs[0]) return ys[0];
  for (let k = 1; k < xs.length; k++) if (x <= xs[k]) return ys[k - 1] + (ys[k] - ys[k - 1]) * (x - xs[k - 1]) / (xs[k] - xs[k - 1]);
  return ys[ys.length - 1];
};

// Scene: four brains seen from the front, like a CT slice stack (the patient's left on screen right).

const canvas = $('out-scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#0d1626');
const camera = new THREE.PerspectiveCamera(26, 1, 10, 8000);
camera.up.set(0, 0, 1);
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(512, 512), 0.55, 0.45, 0.72));
composer.addPass(new OutputPass());
scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x1a0f1a, 0.85));
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(-200, 500, 400);
scene.add(key);
const rim = new THREE.DirectionalLight(0x6fb7f0, 0.9);
rim.position.set(300, -400, 100);
scene.add(rim);

let brainDirs, brainDepth, total = 0;
const lanes = [];

async function loadBrain() {
  const data = await (await fetch('brain.json')).json();
  const sulcDark = new THREE.Color('#3b4862'), gyrus = new THREE.Color('#c2cde0');
  const hemis = [];
  for (const side of ['left', 'right']) {
    const h = data[side];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(h.vertices, 3));
    geo.setIndex(h.faces);
    geo.computeVertexNormals();
    const colors = new Float32Array(h.sulc.length * 3), c = new THREE.Color();
    h.sulc.forEach((s, i) => { c.copy(gyrus).lerp(sulcDark, Math.pow(s, 1.2)); colors.set([c.r, c.g, c.b], i * 3); });
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    hemis.push({ geo, n: h.sulc.length, offset: total });
    total += h.sulc.length;
  }
  brainDirs = new Float32Array(total * 3);
  brainDepth = new Float32Array(total);
  for (const h of hemis) {
    const p = h.geo.attributes.position.array;
    for (let i = 0; i < h.n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2], r = Math.hypot(x, y, z) || 1;
      brainDirs.set([x / r, y / r, z / r], (h.offset + i) * 3);
      brainDepth[h.offset + i] = 90 - r;
    }
  }
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.02 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float heat;\nvarying float vHeat;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHeat = heat;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vHeat;\n${RAMP_GLSL}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, bloodRamp(vHeat) * 0.55, smoothstep(0.04, 0.6, vHeat) * 0.85);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += bloodRamp(vHeat) * smoothstep(0.05, 0.9, vHeat) * 0.75;');
  };
  for (let i = 0; i < LANES; i++) {
    const group = new THREE.Group();
    const brain = new THREE.Group();
    const attrs = [];
    for (const h of hemis) {
      const geo = new THREE.BufferGeometry();
      for (const name of ['position', 'normal', 'color']) geo.setAttribute(name, h.geo.attributes[name]);
      geo.setIndex(h.geo.index);
      const heat = new THREE.BufferAttribute(new Float32Array(h.n), 1).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('heat', heat);
      attrs.push({ attr: heat, offset: h.offset });
      brain.add(new THREE.Mesh(geo, mat));
    }
    // The skull's midline stays put; the brain moves off it as the bleed pushes.
    const midline = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 70, -60), new THREE.Vector3(0, 70, 80)]),
      new THREE.LineDashedMaterial({ color: 0xf2b84b, dashSize: 4, gapSize: 4, transparent: true, opacity: 0.8 }));
    midline.computeLineDistances();
    group.add(brain, midline);
    group.position.x = -(i - (LANES - 1) / 2) * SPACE;  // the front view mirrors x, so lane 1 lands on the left
    scene.add(group);
    lanes.push({ group, brain, attrs, heat: new Float32Array(total), shownVol: -1 });
  }
  resize();
}

function paintBleed(into, start, scale) {
  const lateral = start.lateral * scale, thick = start.thick * scale, depth = start.depth;
  const [ux, uy, uz] = start.dir;
  for (let i = 0; i < into.length; i++) {
    const c = Math.min(1, Math.max(-1, brainDirs[i * 3] * ux + brainDirs[i * 3 + 1] * uy + brainDirs[i * 3 + 2] * uz));
    const latOut = Math.max(Math.acos(c) * 90 - lateral, 0);
    const d = brainDepth[i];
    const depOut = Math.max(depth - d, d - depth - thick, 0);
    into[i] = Math.exp(-((latOut * latOut + depOut * depOut) / 64));
  }
}

function resize() {
  const el = canvas.parentElement, w = el.clientWidth, h = el.clientHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const vfov = THREE.MathUtils.degToRad(camera.fov), hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  camera.userData.fit = Math.max((LANES * SPACE / 2) / Math.tan(hfov / 2), 150 / Math.tan(vfov / 2)) * 1.04;
  layoutLanes();
}
new ResizeObserver(resize).observe(canvas.parentElement);

// Data and playback

let data = null, hours = 0, playing = true, lastFrame = performance.now();

function query() {
  const [side, region] = $('where').value.split('-');
  return new URLSearchParams({
    kind: $('kind').value, side, region, volume: $('volume').value,
    thinners: $('thinners').checked ? 1 : 0, high_bp: $('high_bp').checked ? 1 : 0,
    treat_at: $('treat_at').value, surgery_at: $('surgery_at').value,
  });
}

async function load(useForm) {
  const res = await fetch(`/api/outlook${useForm ? `?${query()}` : ''}`);
  data = await res.json();
  const s = data.start;
  if (!useForm) {
    $('kind').value = s.kind === 'balloon' ? 'subdural' : s.kind;
    $('where').value = `${s.side}-${s.region}`;
    $('volume').value = Math.round(s.volume);
  }
  $('volume-out').textContent = `${Math.round(s.volume)} ml`;
  const where = `${s.side === 'L' ? 'left' : 'right'} ${s.region}`;
  $('start-label').textContent = useForm
    ? `Starting point you set: ${Math.round(s.volume)} ml, ${where}`
    : s.source === 'scan'
    ? `Starting from the last scan: about ${Math.round(s.volume)} ml, ${where}`
    : `Example starting point: ${Math.round(s.volume)} ml, ${where} (run a scan to start from its result)`;
  for (const lane of lanes) lane.shownVol = -1;
  buildLaneLabels();
  charts.forEach((c) => c.draw());
  hours = 0;
  setPlaying(true);
}

function setPlaying(on) {
  playing = on;
  $('play').textContent = on ? 'Pause' : hours >= HOURS ? 'Replay' : 'Play';
  $('play').setAttribute('aria-label', $('play').textContent);
}

$('play').addEventListener('click', () => {
  if (!playing && hours >= HOURS) hours = 0;
  setPlaying(!playing);
});
$('scrub').addEventListener('input', (e) => { hours = Number(e.target.value); setPlaying(false); });
for (const id of ['kind', 'where', 'thinners', 'high_bp', 'treat_at', 'surgery_at']) $(id).addEventListener('change', () => load(true));
$('volume').addEventListener('input', (e) => { $('volume-out').textContent = `${e.target.value} ml`; });
$('volume').addEventListener('change', () => load(true));

for (const side of ['L', 'R']) for (const r of REGIONS) $('where').add(new Option(`${side === 'L' ? 'Left' : 'Right'} ${r}`, `${side}-${r}`));

// Lane headers and readouts over the brains

function buildLaneLabels() {
  const box = $('out-lanes');
  box.innerHTML = '';
  data.lanes.forEach((lane, i) => {
    const el = document.createElement('div');
    el.className = 'lane';
    el.style.setProperty('--c', laneColor(i));
    el.innerHTML = `<h3><i></i>${lane.name}</h3><p class="cond">${lane.conditions}</p><div class="read"></div>`;
    box.appendChild(el);
    lanes[i].label = el;
  });
  $('out-legend').innerHTML = data.lanes.map((lane, i) => `<span><i style="background:${laneColor(i)}"></i>${lane.name}</span>`).join('');
  layoutLanes();
}

function layoutLanes() {
  const w = canvas.clientWidth;
  lanes.forEach((lane) => {
    if (!lane.label) return;
    const p = lane.group.position.clone().project(camera);
    lane.label.style.left = `${((p.x + 1) / 2) * w}px`;
  });
}

// Charts: one axis each, the four lanes as lines, bands where we have them, the guide line, the playhead.

class LaneChart {
  constructor(el, { key, band, guide, guideLabel, fmt, unit, yMin = 0 }) {
    Object.assign(this, { el, key, band, guide, guideLabel, fmt, unit, yMin });
    new ResizeObserver(() => this.draw()).observe(el);
  }

  series(lane) { return this.key === 'z' ? { mean: lane.z } : lane[this.key]; }

  draw() {
    if (!data) return;
    const w = this.el.clientWidth || 300, h = 150, m = { l: 34, r: 10, t: 10, b: 22 };
    const t = data.t;
    let yMax = this.guide * 1.25;
    for (const lane of data.lanes) {
      const s = this.series(lane);
      for (const v of (this.band && s.p90) || s.mean) yMax = Math.max(yMax, v * 1.05);
    }
    const x = (hr) => m.l + (hr / HOURS) * (w - m.l - m.r), y = (v) => m.t + (1 - (v - this.yMin) / (yMax - this.yMin)) * (h - m.t - m.b);
    Object.assign(this, { x, y, m, w, h });
    this.el.innerHTML = '';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('height', h);
    this.el.appendChild(svg);
    const add = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); svg.appendChild(n); return n; };
    for (const f of [0, 0.5, 1]) {
      const v = this.yMin + f * (yMax - this.yMin);
      add('line', { x1: m.l, x2: w - m.r, y1: y(v), y2: y(v), class: 'grid' });
      add('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }).textContent = this.fmt(v);
    }
    for (const hr of [0, 4, 8, 12]) add('text', { x: x(hr), y: h - 5, 'text-anchor': 'middle' }).textContent = hr ? `+${hr} h` : 'now';
    add('line', { x1: m.l, x2: w - m.r, y1: y(this.guide), y2: y(this.guide), class: 'guide' });
    add('text', { x: w - m.r, y: y(this.guide) - 5, 'text-anchor': 'end' }).textContent = this.guideLabel;
    data.lanes.forEach((lane, i) => {
      const s = this.series(lane), col = laneColor(i);
      if (this.band && s.p10) {
        const top = t.map((hr, k) => `${x(hr)},${y(s.p90[k])}`).join(' ');
        const bottom = t.map((hr, k) => `${x(hr)},${y(s.p10[k])}`).reverse().join(' ');
        add('polygon', { points: `${top} ${bottom}`, fill: col, 'fill-opacity': 0.1 });
      }
      add('polyline', { points: t.map((hr, k) => `${x(hr)},${y(s.mean[k])}`).join(' '), fill: 'none', stroke: col, 'stroke-width': 2, 'stroke-linejoin': 'round' });
    });
    this.head = add('line', { y1: m.t, y2: h - m.b, class: 'playhead' });
    this.dots = data.lanes.map((_, i) => add('circle', { r: 4, fill: laneColor(i), stroke: css('--ward'), 'stroke-width': 2 }));
    const hit = add('rect', { x: m.l, y: m.t, width: w - m.l - m.r, height: h - m.t - m.b, fill: 'transparent' });
    hit.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const hr = Math.min(HOURS, Math.max(0, ((e.clientX - r.left) * (w / r.width) - m.l) / (w - m.l - m.r) * HOURS));
      const rows = data.lanes.map((lane, i) => `<span style="color:${laneColor(i)}">━</span> ${lane.name}: <b>${this.fmt(interp(t, this.series(lane).mean, hr))}</b> ${this.unit}`);
      tooltip.show(`<b>+${hr.toFixed(1)} h</b><br>${rows.join('<br>')}`, e.clientX, e.clientY);
    });
    hit.addEventListener('mouseleave', () => tooltip.hide());
    this.playhead(hours);
  }

  playhead(hr) {
    if (!this.head) return;
    this.head.setAttribute('x1', this.x(hr));
    this.head.setAttribute('x2', this.x(hr));
    data.lanes.forEach((lane, i) => {
      this.dots[i].setAttribute('cx', this.x(hr));
      this.dots[i].setAttribute('cy', this.y(interp(data.t, this.series(lane).mean, hr)));
    });
  }
}

const charts = [
  new LaneChart($('chart-volume'), { key: 'volume', band: true, guide: 30, guideLabel: '30 ml', fmt: (v) => v.toFixed(0), unit: 'ml' }),
  new LaneChart($('chart-mls'), { key: 'mls', band: true, guide: 5, guideLabel: '5 mm', fmt: (v) => v.toFixed(1), unit: 'mm' }),
  new LaneChart($('chart-z'), { key: 'z', band: false, guide: 3, guideLabel: 'Lucid flags above 3', fmt: (v) => v.toFixed(1), unit: '' }),
];

// Frame loop

renderer.setAnimationLoop(() => {
  const now = performance.now(), dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (data && playing) {
    hours = Math.min(HOURS, hours + dt * Number($('rate').value));
    if (hours >= HOURS) setPlaying(false);
  }
  const t = now / 1000;
  const fit = camera.userData.fit || 900;
  const sway = REDUCED ? 0 : Math.sin(t * 0.25) * 0.28;
  camera.position.set(Math.sin(sway) * fit, Math.cos(sway) * fit, fit * 0.18);
  camera.lookAt(0, 0, 5);
  if (data && lanes.length) {
    $('scrub').value = hours;
    $('clock').textContent = hours < 0.05 ? 'now' : `+${hours.toFixed(1)} h`;
    const s = data.start;
    data.lanes.forEach((lane, i) => {
      const L = lanes[i];
      const vol = interp(data.t, lane.volume.mean, hours);
      const mls = interp(data.t, lane.mls.mean, hours);
      const z = interp(data.t, lane.z, hours);
      if (Math.abs(vol - L.shownVol) > 0.15) {
        L.shownVol = vol;
        paintBleed(L.heat, s, Math.cbrt(Math.max(vol, 0.5) / s.volume));
        for (const a of L.attrs) { a.attr.array.set(L.heat.subarray(a.offset, a.offset + a.attr.count)); a.attr.needsUpdate = true; }
      }
      L.brain.position.x = (s.dir[0] < 0 ? 1 : -1) * mls;  // pushed away from the bleed
      if (L.label) {
        const volOver = vol >= data.guides.volume_ml, mlsOver = mls >= data.guides.mls_mm;
        L.label.querySelector('.read').innerHTML = `<b class="${volOver ? 'over' : ''}">${vol.toFixed(0)} ml${volOver ? ' <small>over 30</small>' : ''}</b>`
          + `<span class="${mlsOver ? 'over' : ''}">shift ${mls.toFixed(1)} mm${mlsOver ? ', over 5' : ''}</span><br>Lucid reads ${z.toFixed(1)}`;
      }
    });
    charts.forEach((c) => c.playhead(hours));
  }
  layoutLanes();
  composer.render();
});

loadBrain().then(() => load(false));
