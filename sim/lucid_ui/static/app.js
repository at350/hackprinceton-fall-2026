// Wires the server's event stream to the head, the charts and the scan panels.
import { HeadScene } from './scene.js';
import { ChanceChart, Ladder, Strip, tooltip } from './charts.js';
import { setupControls, pct } from './controls.js';
import { GeminiPanel } from './gemini.js';

const $ = (id) => document.getElementById(id);
const spotName = (id) => (id ? id.replace('-', ' ') : '');

const scene = new HeadScene($('scene'), $('labels'));
scene.loadBrain('brain.json');
const chance = new ChanceChart($('p-chart'));
const ladder = new Ladder($('ladder'), $('ladder-table'));
const strips = {
  coil: new Strip($('sig-coil'), { min: -3, max: 0.4, auto: true, fmt: (v) => v.toFixed(1), unit: 'dB' }),
  nir: new Strip($('sig-nir'), { min: 0, max: 0.6, auto: true, fmt: (v) => v.toFixed(2), unit: 'V' }),
  motion: new Strip($('sig-motion'), { min: 0, max: 40, auto: true, fmt: (v) => v.toFixed(0), unit: '°/s' }),
};
(function drawStrips() {
  for (const s of Object.values(strips)) s.draw();
  requestAnimationFrame(drawStrips);
})();

let state = { plan: [], done: [], retake: [], confirm: [], pairs: {}, status: null, final: false, focused: false };

setupControls();
const gemini = new GeminiPanel();
$('truth').addEventListener('change', (e) => scene.showTruth(e.target.checked));
$('ladder-table-toggle').addEventListener('click', (e) => {
  const table = $('ladder-table');
  table.hidden = !table.hidden;
  e.target.setAttribute('aria-expanded', String(!table.hidden));
  e.target.textContent = table.hidden ? 'Show as table' : 'Hide table';
});

// Events

const events = new EventSource('/events');
events.addEventListener('hello', (e) => hello(JSON.parse(e.data)));
events.addEventListener('frames', (e) => frames(JSON.parse(e.data)));
events.addEventListener('update', (e) => update(JSON.parse(e.data)));

function hello(h) {
  state = { plan: h.plan, done: [], retake: [], confirm: [], pairs: {}, status: null, final: false, focused: false };
  $('scan-label').textContent = h.label;
  scene.setSpots(h.spots);
  scene.setTruth(h.truth);
  scene.setSims([], []);
  scene.setCloud([]);
  scene.setCortexHeat(new Uint8Array(0));
  scene.controls.autoRotate = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('truth-toggle').hidden = !h.truth;
  scene.showTruth($('truth').checked && !!h.truth);
  chance.reset(h.prevalence);
  ladder.reset();
  for (const s of Object.values(strips)) s.reset();
  $('log').innerHTML = '';
  $('p-value').textContent = pct(h.prevalence);
  $('verdict-text').textContent = `Before any reading, ${pct(h.prevalence)} is the starting chance. Each finished left/right pair updates it.`;
  document.querySelector('.verdict').className = 'verdict';
  setNext(h.plan[0], 'First spot of the scan.', false);
  renderTimeline();
  gemini.reset();
}

function frames(f) {
  const contact = f.coil_db.map((v) => v < -0.4);
  strips.coil.push(f.t, f.coil_db, contact);
  strips.nir.push(f.t, f.nir, contact);
  strips.motion.push(f.t, f.motion, contact);
  const s = f.status;
  if (!state.final && (!state.status || s.spot !== state.status.spot || s.on_head !== state.status.on_head)) {
    state.status = s;
    scene.setProbe(s);
    const ps = $('probe-state');
    ps.textContent = s.on_head ? `Probe on ${spotName(s.spot)}` : s.spot ? `Probe in the air, next ${spotName(s.spot)}` : 'Probe in the air';
    ps.classList.toggle('on', s.on_head);
    renderTimeline();
  }
}

function update(u) {
  state.done = u.done;
  state.retake = u.retake;
  state.confirm = u.confirm;
  state.final = u.final;
  state.pairs = Object.fromEntries(u.pairs.map((p) => [p.region, p]));

  $('p-value').textContent = pct(u.p_bleed);
  const verdict = document.querySelector('.verdict');
  verdict.className = `verdict ${u.p_bleed >= 0.8 ? 'likely' : u.p_bleed >= 0.3 ? 'possible' : ''}`;
  let text;
  if (u.final) text = u.flag ? u.flag.text : 'Scan complete.';
  else if (!u.pairs_done) text = 'No complete left/right pair yet.';
  else if (u.location.status === 'none') text = `${u.pairs_done} of 5 pairs done. Left and right match so far; nothing bleed-like.`;
  else text = u.location.text;
  $('verdict-text').textContent = text;
  chance.add(u.t_s, u.p_bleed, u.final ? 'end of scan' : `after ${spotName(u.done[u.done.length - 1])}`);

  if (u.final) {
    setNext(null, u.location.status && u.location.status !== 'none' && u.location.text ? u.location.text : 'All ten spots read.', false);
    $('next-spot').textContent = 'Scan complete';
    scene.setProbe(null);
    $('probe-state').textContent = 'Scan complete';
    $('probe-state').classList.remove('on');
  } else if (u.next_spot) {
    const row = u.predictions.find((p) => p.spot === u.next_spot);
    const kind = u.retake.includes(u.next_spot) ? 'retake' : u.confirm.includes(u.next_spot) ? 'confirm' : null;
    let why = kind === 'retake' ? 'The last reading here was not clean enough. ' :
      kind === 'confirm' ? 'This reading changed the picture. A second one tells a real find from bad contact. ' :
        row && row.mirror_done ? 'Finishes a left/right pair. ' : 'Starts a new region. ';
    if (row) {
      const parts = [];
      if (row.sigma_healthy != null) parts.push(`${row.sigma_healthy.toFixed(3)} S/m if healthy`);
      if (row.sigma_if_bleed != null) parts.push(`${row.sigma_if_bleed.toFixed(3)} if a bleed`);
      why += `The simulated heads expect ${parts.join(', ')}; the coil should read ${row.loss_db_lo.toFixed(2)} to ${row.loss_db_hi.toFixed(2)} dB.`;
    }
    setNext(u.next_spot, why, !!kind);
  }

  ladder.update({ sims: u.sims, pairs: u.pairs, next_spot: u.final ? null : u.next_spot });
  scene.setSims(u.sims.bleed, u.sims.points);
  scene.setCloud(u.voxels);
  scene.setCortexHeat(Uint8Array.from(atob(u.cortex), (c) => c.charCodeAt(0)));
  if (u.p_bleed >= 0.8 && !state.focused && u.location.centroid_mm) {
    scene.focus(u.location.centroid_mm);
    state.focused = true;
  }
  for (const id of new Set(u.done)) {
    const [side, region] = id.split('-');
    const p = state.pairs[region];
    const z = p && p.z != null ? (side === 'R' ? p.z : -p.z) : 0;
    scene.setSpotState(id, u.retake.includes(id) || u.confirm.includes(id) ? 'flagged' : 'done', z);
  }
  renderTimeline();
  log(u);
  if (u.final) gemini.handoff();
}

function setNext(spot, why, attention) {
  $('next-spot').textContent = spot ? spotName(spot) : '–';
  $('next-spot').classList.toggle('attn', attention);
  $('next-why').textContent = why;
}

function renderTimeline() {
  const ol = $('timeline');
  const active = state.status && state.status.on_head ? state.status.spot : null;
  ol.innerHTML = '';
  for (const id of [...new Set(state.plan)]) {
    const [side, region] = id.split('-');
    const li = document.createElement('li');
    const done = state.done.includes(id);
    const flagged = state.retake.includes(id) || state.confirm.includes(id);
    let note = 'waiting';
    if (id === active && !state.final) { li.classList.add('active'); note = 'reading'; }
    if (done) {
      li.classList.add('done');
      const p = state.pairs[region];
      note = p && p.z != null ? `pair z ${(side === 'R' ? p.z : -p.z).toFixed(1)}` : 'read';
    }
    if (flagged) { li.classList.add('flagged'); note = state.retake.includes(id) ? 'retake' : 'confirm'; }
    li.innerHTML = `<b>${side}</b><span>${region}</span><small>${note}</small>`;
    ol.appendChild(li);
  }
}

function log(u) {
  const li = document.createElement('li');
  const first = u.final ? (u.flag ? u.flag.text : 'Scan complete.') :
    `${u.done.length} spots, ${u.pairs_done} pairs. Chance of bleed ${pct(u.p_bleed)}.`;
  li.innerHTML = `<time>${u.t_s.toFixed(0)} s</time>`;
  li.append(first + (u.surprises.length ? `\n${u.surprises.join('\n')}` : ''));
  $('log').prepend(li);
}

document.addEventListener('scroll', () => tooltip.hide(), { passive: true });
