// Charts around the head: chance of bleed over the scan, the left/right ladder of simulated heads, and the
// live signal strips. Plain SVG and canvas; colors come from the CSS tokens.
const NS = 'http://www.w3.org/2000/svg';
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const el = (tag, attrs = {}, parent) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
};
const pct = (p) => (p >= 0.995 ? '>99%' : p < 0.005 ? '<1%' : `${Math.round(p * 100)}%`);
const REGION_NAMES = { frontal: 'Frontal', frontotemporal: 'Frontotemporal', temporal: 'Temporal', parietal: 'Parietal', occipital: 'Occipital' };

export const tooltip = {
  node: document.getElementById('tooltip'),
  show(html, x, y) {
    this.node.innerHTML = html;
    this.node.hidden = false;
    const r = this.node.getBoundingClientRect();
    this.node.style.left = `${Math.min(x + 14, innerWidth - r.width - 8)}px`;
    this.node.style.top = `${Math.max(8, y - r.height - 10)}px`;
  },
  hide() { this.node.hidden = true; },
};

export class ChanceChart {
  constructor(container) {
    this.container = container;
    this.points = [];
    this.prevalence = 0.1;
    new ResizeObserver(() => this.draw()).observe(container);
  }

  reset(prevalence) { this.points = []; this.prevalence = prevalence; this.draw(); }
  add(t, p, label) { this.points.push({ t, p, label }); this.draw(); }

  draw() {
    const w = this.container.clientWidth || 320, h = 112, m = { l: 34, r: 8, t: 8, b: 20 };
    this.container.innerHTML = '';
    const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, height: h, role: 'img', 'aria-label': 'Chance of bleed after each spot' }, this.container);
    const tMax = Math.max(60, ...this.points.map((d) => d.t));
    const x = (t) => m.l + (t / tMax) * (w - m.l - m.r), y = (p) => m.t + (1 - p) * (h - m.t - m.b);
    for (const p of [0, 0.5, 1]) {
      el('line', { x1: m.l, x2: w - m.r, y1: y(p), y2: y(p), class: 'grid' }, svg);
      el('text', { x: m.l - 6, y: y(p) + 4, 'text-anchor': 'end' }, svg).textContent = `${p * 100}%`;
    }
    el('line', { x1: m.l, x2: w - m.r, y1: y(this.prevalence), y2: y(this.prevalence), stroke: css('--ink-3'), 'stroke-dasharray': '3 4' }, svg);
    el('text', { x: w - m.r, y: y(this.prevalence) - 5, 'text-anchor': 'end' }, svg).textContent = 'before scanning';
    el('text', { x: m.l, y: h - 4 }, svg).textContent = '0 s';
    el('text', { x: w - m.r, y: h - 4, 'text-anchor': 'end' }, svg).textContent = `${Math.round(tMax)} s`;
    if (!this.points.length) return;
    let d = `M${x(0)},${y(this.prevalence)}`;
    let prev = this.prevalence;
    for (const pt of this.points) { d += `H${x(pt.t)}V${y(pt.p)}`; prev = pt.p; }
    el('path', { d, fill: 'none', stroke: css('--ember'), 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
    this.points.forEach((pt, i) => {
      const last = i === this.points.length - 1;
      const c = el('circle', { cx: x(pt.t), cy: y(pt.p), r: last ? 5 : 4, fill: css('--ember'), stroke: css('--ward'), 'stroke-width': 2 }, svg);
      const hit = el('circle', { cx: x(pt.t), cy: y(pt.p), r: 12, fill: 'transparent' }, svg);
      hit.addEventListener('mousemove', (e) => tooltip.show(`<b>${pct(pt.p)}</b> chance of bleed<br><span class="muted">${pt.t.toFixed(0)} s, ${pt.label}</span>`, e.clientX, e.clientY));
      hit.addEventListener('mouseleave', () => tooltip.hide());
      c.style.pointerEvents = 'none';
    });
  }
}

const jitter = (i) => {
  const s = Math.sin(i * 12.9898) * 43758.5453;
  return s - Math.floor(s) - 0.5;
};

export class Ladder {
  constructor(container, table) {
    this.container = container;
    this.table = table;
    this.regions = ['frontal', 'frontotemporal', 'temporal', 'parietal', 'occipital'];
    this.data = null;
    this.svg = null;
    this.dots = new Map();
    new ResizeObserver(() => this.layout(true)).observe(container);
  }

  reset() { this.data = null; this.container.innerHTML = ''; this.svg = null; this.dots.clear(); this.layout(true); }

  update(data) { this.data = data; this.layout(false); }

  layout(rebuild) {
    const w = this.container.clientWidth || 340;
    const rowH = 44, m = { l: 104, r: 48, t: 6, b: 34 };
    const h = m.t + rowH * this.regions.length + m.b;
    if (rebuild || !this.svg || this.svgW !== w) {
      this.container.innerHTML = '';
      this.svg = el('svg', { viewBox: `0 0 ${w} ${h}`, height: h, role: 'img', 'aria-label': 'Right minus left conductivity per region, measured and simulated' }, this.container);
      this.gBack = el('g', {}, this.svg);
      this.gDots = el('g', {}, this.svg);
      this.gFront = el('g', {}, this.svg);
      this.dots.clear();
      this.svgW = w;
    }
    const data = this.data || { sims: { bleed: [], pair_d: [], regions: this.regions }, pairs: [] };
    const sims = data.sims;
    const pairs = Object.fromEntries((data.pairs || []).map((p) => [p.region, p]));
    let span = 0.06;
    sims.regions.forEach((r, j) => {
      const vals = (sims.pair_d[j] || []).map(Math.abs).sort((a, b) => a - b);
      if (vals.length) span = Math.max(span, vals[Math.floor(vals.length * 0.98)] * 1.1);
    });
    for (const p of Object.values(pairs)) span = Math.max(span, (Math.abs(p.d_sigma) + 2 * p.d_sigma_se) * 1.1);
    span = Math.ceil(span * 50) / 50;
    const x = (v) => m.l + ((v + span) / (2 * span)) * (w - m.l - m.r);
    const rowY = (j) => m.t + rowH * j + rowH / 2;

    this.gBack.innerHTML = '';
    this.gFront.innerHTML = '';
    const nextRegion = data.next_spot ? data.next_spot.split('-')[1] : null;
    this.regions.forEach((r, j) => {
      if (r === nextRegion) el('rect', { x: 0, y: rowY(j) - rowH / 2 + 2, width: w, height: rowH - 4, rx: 6, fill: css('--panel') }, this.gBack);
      el('text', { x: 0, y: rowY(j) + 4, class: 'axis-label' }, this.gBack).textContent = REGION_NAMES[r];
      el('line', { x1: m.l, x2: w - m.r, y1: rowY(j) + rowH / 2, y2: rowY(j) + rowH / 2, class: 'grid' }, this.gBack);
    });
    el('line', { x1: x(0), x2: x(0), y1: m.t, y2: h - m.b, class: 'zero' }, this.gBack);
    for (const v of [-span, -span / 2, span / 2, span]) {
      el('text', { x: x(v), y: h - m.b + 14, 'text-anchor': 'middle' }, this.gBack).textContent = v.toFixed(2);
    }
    el('text', { x: x(0), y: h - m.b + 14, 'text-anchor': 'middle' }, this.gBack).textContent = '0';
    el('text', { x: m.l, y: h - 3, class: 'axis-label' }, this.gBack).textContent = '← left higher';
    el('text', { x: w - m.r, y: h - 3, 'text-anchor': 'end', class: 'axis-label' }, this.gBack).textContent = 'right higher →';
    el('text', { x: (m.l + w - m.r) / 2, y: h - 3, 'text-anchor': 'middle' }, this.gBack).textContent = 'S/m';

    // The simulated heads: one dot each per region, flying to their new place on every update.
    const frost = css('--frost'), ember = css('--ember');
    sims.regions.forEach((r, jr) => {
      const j = this.regions.indexOf(r);
      const vals = sims.pair_d[jr] || [];
      vals.forEach((v, i) => {
        const key = `${r}:${i}`;
        let c = this.dots.get(key);
        const cx = x(Math.max(-span, Math.min(span, v))), cy = rowY(j) + jitter(i + jr * 1000) * rowH * 0.62;
        if (!c) {
          c = el('circle', { r: 1.8, class: 'sim-dot', 'fill-opacity': 0.62 }, this.gDots);
          c.style.cx = `${x(0)}px`;
          c.style.cy = `${rowY(j)}px`;
          this.dots.set(key, c);
          c.getBoundingClientRect();  // let the start position land before the transition
        }
        c.style.cx = `${cx}px`;
        c.style.cy = `${cy}px`;
        c.style.fill = sims.bleed[i] ? ember : frost;
      });
    });

    // Measured differences and their 3-standard-error thresholds.
    this.regions.forEach((r, j) => {
      const p = pairs[r], y = rowY(j);
      const hit = el('rect', { x: m.l, y: y - rowH / 2, width: w - m.l - m.r, height: rowH, fill: 'transparent' }, this.gFront);
      const jr = sims.regions.indexOf(r);
      const vals = jr >= 0 ? sims.pair_d[jr] || [] : [];
      const nBleed = sims.bleed.filter((b) => b).length;
      if (p && p.d_sigma != null) {
        for (const s of [-3, 3]) {
          el('line', { x1: x(s * p.d_sigma_se), x2: x(s * p.d_sigma_se), y1: y - rowH * 0.36, y2: y + rowH * 0.36, stroke: css('--warn'), 'stroke-width': 1, 'stroke-dasharray': '2 3', opacity: 0.7 }, this.gFront);
        }
        el('line', { x1: x(p.d_sigma - 2 * p.d_sigma_se), x2: x(p.d_sigma + 2 * p.d_sigma_se), y1: y, y2: y, stroke: css('--ink'), 'stroke-width': 2, 'stroke-linecap': 'round' }, this.gFront);
        el('circle', { cx: x(p.d_sigma), cy: y, r: 5, fill: css('--ink'), stroke: css('--ward'), 'stroke-width': 2 }, this.gFront);
        el('text', { x: w, y: y + 4, 'text-anchor': 'end', class: Math.abs(p.z) >= 3 ? 'axis-label' : '' }, this.gFront).textContent = `z ${p.z.toFixed(1)}`;
      } else {
        el('text', { x: w, y: y + 4, 'text-anchor': 'end' }, this.gFront).textContent = 'to scan';
      }
      hit.addEventListener('mousemove', (e) => {
        const med = vals.length ? [...vals].sort((a, b) => a - b)[Math.floor(vals.length / 2)] : null;
        let html = `<b>${REGION_NAMES[r]}</b><br>`;
        if (p && p.d_sigma != null) {
          html += `Measured right − left ${p.d_sigma >= 0 ? '+' : ''}${p.d_sigma.toFixed(3)} ± ${p.d_sigma_se.toFixed(3)} S/m, z ${p.z.toFixed(1)}`;
          html += Math.abs(p.z) >= 3 ? `<br>${p.z > 0 ? 'Right' : 'Left'} reads clearly higher` : '<br>Within normal left/right spread';
        } else {
          html += 'Not scanned yet';
        }
        if (med != null) html += `<br><span class="muted">${nBleed} of ${sims.bleed.length} simulated heads have a bleed; their median here is ${med >= 0 ? '+' : ''}${med.toFixed(3)}</span>`;
        tooltip.show(html, e.clientX, e.clientY);
      });
      hit.addEventListener('mouseleave', () => tooltip.hide());
    });
    this._table(pairs, sims);
  }

  _table(pairs, sims) {
    const body = this.table.querySelector('tbody');
    const nBleed = sims.bleed.filter((b) => b).length;
    body.innerHTML = this.regions.map((r) => {
      const p = pairs[r];
      const d = p && p.d_sigma != null ? `${p.d_sigma >= 0 ? '+' : ''}${p.d_sigma.toFixed(3)} ± ${p.d_sigma_se.toFixed(3)}` : 'not scanned';
      const z = p && p.z != null ? p.z.toFixed(1) : '–';
      return `<tr><td>${REGION_NAMES[r]}</td><td>${d}</td><td>${z}</td><td>${sims.bleed.length ? `${nBleed} of ${sims.bleed.length}` : '–'}</td></tr>`;
    }).join('');
  }
}

export class Strip {
  // One live signal, one axis. Shaded stretches are the probe on a spot.
  constructor(canvas, { min, max, auto = false, fmt = (v) => v.toFixed(1), unit = '' }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.min = min; this.max = max; this.auto = auto; this.fmt = fmt; this.unit = unit;
    this.t = []; this.v = []; this.contact = [];
    this.window = 20;
    this.dirty = true;
    new ResizeObserver(() => { this.size(); this.dirty = true; }).observe(canvas);
    this.size();
    canvas.addEventListener('mousemove', (e) => this.hover(e));
    canvas.addEventListener('mouseleave', () => { this.hoverX = null; tooltip.hide(); this.dirty = true; });
  }

  size() {
    const r = this.canvas.getBoundingClientRect();
    this.w = r.width; this.h = r.height;
    this.canvas.width = r.width * devicePixelRatio;
    this.canvas.height = r.height * devicePixelRatio;
  }

  reset() { this.t = []; this.v = []; this.contact = []; this.dirty = true; }

  push(ts, vs, contacts) {
    for (let i = 0; i < ts.length; i++) { this.t.push(ts[i]); this.v.push(vs[i]); this.contact.push(contacts[i]); }
    const cut = this.t.length ? this.t[this.t.length - 1] - this.window - 1 : 0;
    let k = 0;
    while (k < this.t.length && this.t[k] < cut) k++;
    if (k) { this.t.splice(0, k); this.v.splice(0, k); this.contact.splice(0, k); }
    this.dirty = true;
  }

  hover(e) {
    const r = this.canvas.getBoundingClientRect();
    this.hoverX = e.clientX - r.left;
    this.dirty = true;
    const t = this._tAt(this.hoverX);
    if (t == null) return;
    let best = 0;
    for (let i = 0; i < this.t.length; i++) if (Math.abs(this.t[i] - t) < Math.abs(this.t[best] - t)) best = i;
    if (this.t.length) tooltip.show(`<b>${this.fmt(this.v[best])}</b> ${this.unit}<br><span class="muted">${this.t[best].toFixed(1)} s${this.contact[best] ? ', probe on a spot' : ''}</span>`, e.clientX, e.clientY);
  }

  _tAt(px) {
    if (!this.t.length) return null;
    const tEnd = this.t[this.t.length - 1];
    return tEnd - this.window + ((px - 4) / (this.w - 44)) * this.window;
  }

  draw() {
    if (!this.dirty) return;
    this.dirty = false;
    const { ctx, w, h } = this;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const plotW = w - 44, top = 4, bottom = h - 6;
    let lo = this.min, hi = this.max;
    if (this.auto && this.v.length) {
      lo = Math.min(this.min, ...this.v); hi = Math.max(this.max, ...this.v);
      const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    }
    const y = (v) => bottom - ((v - lo) / (hi - lo || 1)) * (bottom - top);
    const tEnd = this.t.length ? this.t[this.t.length - 1] : this.window;
    const x = (t) => 4 + ((t - (tEnd - this.window)) / this.window) * plotW;
    ctx.font = `11px ${css('--num')}`;
    ctx.fillStyle = css('--ink-3');
    ctx.strokeStyle = css('--line');
    ctx.lineWidth = 1;
    for (const v of [lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1]) {
      ctx.beginPath(); ctx.moveTo(4, y(v)); ctx.lineTo(4 + plotW, y(v)); ctx.stroke();
      ctx.fillText(this.fmt(v), plotW + 8, y(v) + 4);
    }
    // Probe-on-spot stretches.
    ctx.fillStyle = 'rgba(224, 96, 47, 0.10)';
    let start = null;
    for (let i = 0; i <= this.t.length; i++) {
      const on = i < this.t.length && this.contact[i];
      if (on && start == null) start = this.t[i];
      if (!on && start != null) { ctx.fillRect(x(start), top, x(this.t[i - 1]) - x(start), bottom - top); start = null; }
    }
    ctx.strokeStyle = css('--ink');
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < this.t.length; i++) {
      const px = x(this.t[i]), py = y(Math.max(lo, Math.min(hi, this.v[i])));
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    if (this.hoverX != null) {
      ctx.strokeStyle = css('--ink-3');
      ctx.beginPath(); ctx.moveTo(this.hoverX, top); ctx.lineTo(this.hoverX, bottom); ctx.stroke();
    }
  }
}
