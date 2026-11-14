// Race: many simulated patients, each a line of "chance of bleed" after each spot, drawn growing together;
// the scan running now drawn on top, live. Bleed patients climb where the probe passes over their bleed;
// healthy ones sink. The side panel says what it adds up to.
import { tooltip } from './charts.js';
import { setupControls, pct } from './controls.js';
import { RaceHead } from './race3d.js';

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const REGIONS = ['Frontal', 'Frontotemporal', 'Temporal', 'Parietal', 'Occipital'];
const KIND_NAMES = { subdural: 'subdural', epidural: 'epidural', intracerebral: 'deep' };
const spotName = (id) => (id ? `${id[0] === 'L' ? 'left' : 'right'} ${id.slice(2)}` : '');
const STEP_S = 0.9;  // seconds per spot in the race animation
const head = new RaceHead(document.getElementById('race-3d'));
head.loadBrain('brain.json');

let race = null;
let filter = { size: 'all', kind: 'all' };
let raceStart = 0;
let hover = null;
let live = { curve: [], label: '', late: false };

const canvas = $('race-canvas');
const ctx = canvas.getContext('2d');
let W = 0, H = 0;
const M = { l: 46, r: 92, t: 14, b: 46 };

function resize() {
  const r = canvas.getBoundingClientRect();
  W = r.width; H = r.height;
  canvas.width = W * devicePixelRatio;
  canvas.height = H * devicePixelRatio;
}
new ResizeObserver(resize).observe(canvas.parentElement);

const x = (k) => M.l + (k / 10) * (W - M.l - M.r);
const y = (p) => M.t + (1 - p) * (H - M.t - M.b);

function matches(p) {
  if (!p.bleed) return true;
  if (filter.kind !== 'all' && p.kind !== filter.kind) return false;
  if (filter.size !== 'all') {
    const [lo, hi] = filter.size.split('-').map(Number);
    if (p.volume < lo || p.volume >= hi + (hi === 60 ? 1 : 0)) return false;
  }
  return true;
}

function pathTo(curve, upto) {
  // Points up to a fractional spot count, so lines grow smoothly.
  const pts = [];
  const last = Math.min(curve.length - 1, Math.floor(upto));
  for (let k = 0; k <= last; k++) pts.push([k, curve[k]]);
  if (upto < curve.length - 1 && upto > last) {
    const f = upto - last;
    pts.push([upto, curve[last] + (curve[last + 1] - curve[last]) * f]);
  }
  return pts;
}

function strokeCurve(pts) {
  ctx.beginPath();
  pts.forEach(([k, p], i) => {
    if (i === 0) { ctx.moveTo(x(k), y(p)); return; }
    const [k0, p0] = pts[i - 1];
    const xm = (x(k0) + x(k)) / 2;
    ctx.bezierCurveTo(xm, y(p0), xm, y(p), x(k), y(p));  // flat at each spot, easing between
  });
  ctx.stroke();
}

function draw(t) {
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!W) return;
  const ink3 = css('--ink-3'), line = css('--line');
  ctx.font = `11px ${css('--num')}`;

  // Axes: chance on the left, spots along the bottom grouped into left/right pairs.
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.fillStyle = ink3;
  ctx.textAlign = 'right';
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    ctx.beginPath(); ctx.moveTo(M.l, y(p)); ctx.lineTo(W - M.r, y(p)); ctx.stroke();
    ctx.fillText(`${p * 100}%`, M.l - 8, y(p) + 4);
  }
  ctx.textAlign = 'center';
  for (let k = 0; k <= 10; k++) {
    ctx.fillText(k === 0 ? 'start' : (k % 2 ? 'L' : 'R'), x(k), H - M.b + 16);
  }
  REGIONS.forEach((name, i) => {
    const a = x(2 * i + 1), b = x(2 * i + 2);
    ctx.fillStyle = css('--ink-2');
    ctx.fillText(name, (a + b) / 2, H - M.b + 34);
    ctx.strokeStyle = line;
    ctx.beginPath(); ctx.moveTo(a, H - M.b + 22); ctx.lineTo(b, H - M.b + 22); ctx.stroke();
  });
  if (race) {
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = ink3;
    ctx.beginPath(); ctx.moveTo(M.l, y(race.prevalence)); ctx.lineTo(W - M.r, y(race.prevalence)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.textAlign = 'left';
    ctx.fillStyle = ink3;
    ctx.fillText('before scanning', W - M.r + 8, y(race.prevalence) + 4);
  }
  if (!race) return;

  const upto = REDUCED ? 10 : Math.min(10, Math.max(0, t - raceStart) / STEP_S);
  const ember = css('--ember'), frost = css('--frost');
  // Dimmed lines first, then bleeds, then healthy on top: the healthy band near the bottom would
  // otherwise hide under bleeds that never climbed.
  const order = [...race.patients].sort((a, b) => (matches(a) - matches(b)) || (b.bleed - a.bleed));
  ctx.lineWidth = 1.3;
  ctx.lineJoin = 'round';
  for (const p of order) {
    const on = matches(p);
    ctx.globalAlpha = on ? (p.bleed ? 0.42 : 0.5) : 0.06;
    ctx.strokeStyle = p.bleed ? ember : frost;
    strokeCurve(pathTo(p.curve, upto));
  }
  // Heads of the lines while the race runs.
  if (upto < 10) {
    for (const p of order) {
      if (!matches(p)) continue;
      const pts = pathTo(p.curve, upto), [k, v] = pts[pts.length - 1];
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = p.bleed ? ember : frost;
      ctx.beginPath(); ctx.arc(x(k), y(v), 1.8, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  if (hover) {
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = hover.bleed ? ember : frost;
    strokeCurve(pathTo(hover.curve, 10));
  }

  // This scan, live, on top of everything.
  if (live.curve.length) {
    const pts = live.curve.map((p, k) => [k, p]);
    if (!live.late) {
      ctx.lineWidth = 4;
      ctx.strokeStyle = css('--ward');
      strokeCurve(pts);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = css('--ink');
      strokeCurve(pts);
    }
    const [k, v] = pts[pts.length - 1];
    ctx.fillStyle = css('--ink');
    ctx.beginPath(); ctx.arc(x(k), y(v), 5, 0, Math.PI * 2); ctx.fill();
    ctx.textAlign = 'left';
    ctx.font = `600 12px ${css('--ui')}`;
    ctx.fillText(`This scan ${pct(v)}`, Math.min(x(k) + 10, W - M.r + 4), y(v) - 8);
  }
}

function loop(t) {
  const s = t / 1000;
  draw(s);
  const upto = race ? (REDUCED ? 10 : Math.min(10, Math.max(0, s - raceStart) / STEP_S)) : 0;
  head.frame(upto, matches, hover, s);
  requestAnimationFrame(loop);
}

// Hover: the line nearest the pointer.

canvas.addEventListener('mousemove', (e) => {
  if (!race) return;
  const r = canvas.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const k = Math.max(0, Math.min(10, ((mx - M.l) / (W - M.l - M.r)) * 10));
  let best = null, bestD = 10;
  for (const p of race.patients) {
    if (!matches(p)) continue;
    const k0 = Math.floor(k), k1 = Math.min(10, k0 + 1), f = k - k0;
    const v = p.curve[k0] + (p.curve[k1] - p.curve[k0]) * f;
    const d = Math.abs(y(v) - my);
    if (d < bestD) { bestD = d; best = p; }
  }
  hover = best;
  if (!best) { tooltip.hide(); return; }
  const crossed = best.curve.findIndex((v) => v >= 0.5);
  let html;
  if (best.bleed) {
    html = `<b>${Math.round(best.volume)} ml ${KIND_NAMES[best.kind]} bleed, ${spotName(best.spot)}</b><br>`
      + (crossed > 0 ? `Passed 50% at spot ${crossed} (${spotName(race.spots[crossed - 1])})` : 'Never passed 50%')
      + `<br><span class="muted">${best.caught ? 'Flagged on the right side' : 'Not flagged'}; ends at ${pct(best.curve[10])}</span>`;
  } else {
    html = `<b>Healthy head</b><br>Ends at ${pct(best.curve[10])}<br><span class="muted">${best.false_alarm ? 'False alarm' : 'Not flagged'}</span>`;
  }
  tooltip.show(html, e.clientX, e.clientY);
});
canvas.addEventListener('mouseleave', () => { hover = null; tooltip.hide(); });

// Side panel

function stats() {
  const bleeds = race.patients.filter((p) => p.bleed && matches(p));
  const healthy = race.patients.filter((p) => !p.bleed);
  const caught = bleeds.filter((p) => p.caught).length;
  $('stat-caught').textContent = `${caught}/${bleeds.length}`;
  $('stat-caught-label').textContent = filter.size === 'all' && filter.kind === 'all'
    ? 'bleeds flagged on the right side' : 'highlighted bleeds flagged on the right side';
  const fa = healthy.filter((p) => p.false_alarm).length;
  $('stat-false').textContent = `${fa}/${healthy.length}`;
  endpoint();
  breakdown();
}

function endpoint() {
  const el = $('endpoint');
  const w = el.clientWidth || 300, h = 92, m = { l: 62, r: 10 };
  const xs = (p) => m.l + p * (w - m.l - m.r);
  const rows = [['Bleed', true, css('--ember'), 26], ['Healthy', false, css('--frost'), 56]];
  let svg = `<svg viewBox="0 0 ${w} ${h}" height="${h}" role="img" aria-label="Final chance of bleed per patient">`;
  for (const [name, isBleed, col, cy] of rows) {
    svg += `<text x="0" y="${cy + 4}">${name}</text>`;
    race.patients.filter((p) => p.bleed === isBleed).forEach((p, i) => {
      const jitter = ((i * 37) % 13 - 6) * 1.2;
      const op = matches(p) ? 0.75 : 0.12;
      svg += `<circle cx="${xs(p.curve[10]).toFixed(1)}" cy="${cy + jitter}" r="2.4" fill="${col}" fill-opacity="${op}"/>`;
    });
  }
  for (const v of [0, 0.5, 1]) svg += `<text x="${xs(v)}" y="${h - 2}" text-anchor="middle">${v * 100}%</text>`;
  el.innerHTML = `${svg}</svg>`;
}

function breakdown() {
  const bleeds = race.patients.filter((p) => p.bleed);
  const row = (label, list) => {
    const n = list.length, c = list.filter((p) => p.caught).length;
    const f = n ? c / n : 0;
    return `<tr><td>${label}</td><td><div class="meter" role="img" aria-label="${Math.round(f * 100)}%"><i style="width:${f * 100}%"></i></div></td><td>${c}/${n}</td></tr>`;
  };
  const bySize = [[10, 25], [25, 40], [40, 61]].map(([lo, hi]) => row(`${lo}–${Math.min(hi, 60)} ml`, bleeds.filter((p) => p.volume >= lo && p.volume < hi)));
  const byKind = Object.entries(KIND_NAMES).map(([k, name]) => row(name[0].toUpperCase() + name.slice(1), bleeds.filter((p) => p.kind === k)));
  $('breakdown').querySelector('tbody').innerHTML = `<tr><th colspan="3">By size</th></tr>${bySize.join('')}<tr><th colspan="3">By type</th></tr>${byKind.join('')}`;
}

// Filters and replay

for (const [boxId, key] of [['size-chips', 'size'], ['kind-chips', 'kind']]) {
  $(boxId).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    filter[key] = b.dataset[key];
    $(boxId).querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    stats();
  });
}
$('replay').addEventListener('click', () => { raceStart = performance.now() / 1000; });

// The live scan

function hello(h) {
  live = { curve: [h.prevalence ?? 0.1], label: h.label, late: false };
  head.setLive(null);
  $('scan-label').textContent = h.label;
  $('live-text').textContent = `${h.label}: waiting for the first spot.`;
}

function update(u) {
  const k = new Set(u.done).size;
  // Joined after the scan was under way: the earlier spots were never seen, so don't draw them as flat.
  if (live.curve.length === 1 && k > 1) live.late = true;
  while (live.curve.length <= k) live.curve.push(live.curve[live.curve.length - 1]);
  live.curve[k] = u.p_bleed;
  live.curve.length = k + 1;
  head.setLive(u.p_bleed >= 0.5 && u.location && u.location.peak_mm ? u.location.peak_mm : null);
  if (!race) return;
  // Which crowd is it running with? Compare against the patients at the same spot.
  const near = race.patients.map((p) => ({ p, d: Math.abs(p.curve[k] - u.p_bleed) })).sort((a, b) => a.d - b.d).slice(0, 20);
  const nBleed = near.filter((n) => n.p.bleed).length;
  const crowd = nBleed >= 14 ? 'running with the bleed patients' : nBleed <= 6 ? 'running with the healthy heads' : 'between the two crowds';
  $('live-text').textContent = u.final
    ? `${live.label}: ended at ${pct(u.p_bleed)}, ${crowd}. ${u.flag ? u.flag.text : ''}`
    : `${live.label}: ${k} of 10 spots, ${pct(u.p_bleed)}, ${crowd}.`;
}

setupControls();
fetch('race.json').then((r) => r.json()).then((data) => {
  race = data;
  head.setSpots(data.spots);
  head.setPatients(data.patients);
  const n = data.patients.length;
  $('race-title').textContent = `${n} simulated patients, scanned spot by spot`;
  raceStart = performance.now() / 1000 + 0.4;
  stats();
});
const events = new EventSource('/events');
events.addEventListener('hello', (ev) => hello(JSON.parse(ev.data)));
events.addEventListener('update', (ev) => update(JSON.parse(ev.data)));
requestAnimationFrame(loop);
