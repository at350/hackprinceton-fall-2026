// The 3D head: fsaverage cortex fitted inside the model skull, a glass scalp, the ten scan spots, the probe,
// the cloud of likely blood, and the swarm of simulated heads. Head frame: +x right ear, +y nose, +z up (mm).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const R = 90;
const N_SIMS = 500;
const FROST = new THREE.Color('#6fb7f0');   // brighter than the chart frost: these are lights, not marks
const EMBER = new THREE.Color('#ff6a35');
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

const RAMP_GLSL = `
vec3 bloodRamp(float t) {
  vec3 c0 = vec3(0.227, 0.055, 0.122), c1 = vec3(0.702, 0.141, 0.231);
  vec3 c2 = vec3(0.933, 0.420, 0.231), c3 = vec3(1.0, 0.827, 0.541);
  t = clamp(t, 0.0, 1.0);
  return t < 0.35 ? mix(c0, c1, t / 0.35) : t < 0.7 ? mix(c1, c2, (t - 0.35) / 0.35) : mix(c2, c3, (t - 0.7) / 0.3);
}`;

export function bloodColor(t) {
  const stops = [[0, '#3a0e1f'], [0.35, '#b3243b'], [0.7, '#ee6b3b'], [1, '#ffd38a']].map(([s, c]) => [s, new THREE.Color(c)]);
  t = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [s0, c0] = stops[i - 1], [s1, c1] = stops[i];
      return c0.clone().lerp(c1, (t - s0) / (s1 - s0));
    }
  }
  return stops[3][1].clone();
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class HeadScene {
  constructor(canvas, labelsEl) {
    this.canvas = canvas;
    this.labelsEl = labelsEl;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 1, 3000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(-330, 300, 170);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.autoRotate = !REDUCED;
    this.controls.autoRotateSpeed = 0.45;
    this.controls.minDistance = 220;
    this.controls.maxDistance = 900;
    this.controls.enablePan = false;
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; });
    canvas.addEventListener('wheel', () => { this.userZoomed = true; }, { passive: true });

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.75, 0.55, 0.62);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.clock = new THREE.Clock();
    this.spots = new Map();
    this.labels = [];
    this.heat = null;
    this.probe = { target: new THREE.Vector3(0, 0, R * 1.9), onHead: false };

    this._lights();
    this._scalp();
    this._swarm();
    this._cloud();
    this._probe();
    this._truth();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  _lights() {
    this.scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x1a0f1a, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-200, 260, 320);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x6fb7f0, 1.1);
    rim.position.set(260, -300, 60);
    this.scene.add(rim);
  }

  _scalp() {
    const glass = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: FROST.clone().multiplyScalar(0.9) } },
      vertexShader: `varying vec3 vN; varying vec3 vV;
        void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 uColor; varying vec3 vN; varying vec3 vV;
        void main() { float f = pow(1.0 - abs(dot(vN, vV)), 2.6); gl_FragColor = vec4(uColor * (0.025 + 0.5 * f), 1.0); }`,
    });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(R, 96, 64), glass));
    // Reference circles: the ear line and the midline.
    const ring = (rotate) => {
      const pts = [];
      for (let i = 0; i <= 128; i++) {
        const a = (i / 128) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 0));
      }
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x2b4570, transparent: true, opacity: 0.55 }));
      rotate(line);
      this.scene.add(line);
    };
    ring(() => {});
    ring((l) => l.rotateY(Math.PI / 2));
    // Nose.
    const nose = new THREE.Mesh(new THREE.ConeGeometry(7, 18, 24),
      new THREE.MeshStandardMaterial({ color: 0x3a5c8c, roughness: 0.6, transparent: true, opacity: 0.7 }));
    nose.position.set(0, R + 6, -6);
    nose.rotation.x = -Math.PI / 2;
    this.scene.add(nose);
    for (const [text, pos] of [['Left', [-R * 1.22, 0, 0]], ['Right', [R * 1.22, 0, 0]], ['Front', [0, R * 1.3, -6]]]) {
      this._label(text, new THREE.Vector3(...pos), 'side', null);
    }
  }

  async loadBrain(url) {
    const data = await (await fetch(url)).json();
    const sulcDark = new THREE.Color('#3b4862'), gyrus = new THREE.Color('#c2cde0');
    this.heat = { current: [], target: [], attrs: [], offsets: [] };
    let offset = 0;
    for (const side of ['left', 'right']) {
      const h = data[side];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(h.vertices, 3));
      geo.setIndex(h.faces);
      geo.computeVertexNormals();
      const n = h.sulc.length;
      const colors = new Float32Array(n * 3);
      const c = new THREE.Color();
      for (let i = 0; i < n; i++) {
        c.copy(gyrus).lerp(sulcDark, Math.pow(h.sulc[i], 1.2));
        colors.set([c.r, c.g, c.b], i * 3);
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const heat = new THREE.BufferAttribute(new Float32Array(n), 1);
      heat.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('heat', heat);
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.02 });
      mat.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float heat;\nvarying float vHeat;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHeat = heat;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\nvarying float vHeat;\n${RAMP_GLSL}`)
          .replace('#include <color_fragment>',
            '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, bloodRamp(vHeat) * 0.55, smoothstep(0.04, 0.6, vHeat) * 0.85);')
          .replace('#include <emissivemap_fragment>',
            '#include <emissivemap_fragment>\ntotalEmissiveRadiance += bloodRamp(vHeat) * smoothstep(0.05, 0.9, vHeat) * 1.35;');
      };
      const mesh = new THREE.Mesh(geo, mat);
      this.scene.add(mesh);
      this.heat.attrs.push(heat);
      this.heat.offsets.push(offset);
      offset += n;
    }
    this.heat.current = new Float32Array(offset);
    this.heat.target = new Float32Array(offset);
  }

  setCortexHeat(bytes) {
    if (!this.heat) return;
    for (let i = 0; i < this.heat.target.length; i++) this.heat.target[i] = (bytes[i] || 0) / 255;
  }

  _label(text, pos, cls, normal) {
    const el = document.createElement('span');
    el.textContent = text;
    if (cls) el.className = cls;
    this.labelsEl.appendChild(el);
    this.labels.push({ el, pos, normal });
    return el;
  }

  setSpots(spots) {
    for (const s of this.spots.values()) this.scene.remove(s.group);
    this.spots.clear();
    this.labels = this.labels.filter((l) => { if (l.normal) { l.el.remove(); return false; } return true; });
    for (const s of spots) {
      const pos = new THREE.Vector3(...s.pos);
      const normal = pos.clone().normalize();
      const group = new THREE.Group();
      group.position.copy(pos);
      group.lookAt(pos.clone().multiplyScalar(2));
      const ring = new THREE.Mesh(new THREE.RingGeometry(5.2, 6.4, 48),
        new THREE.MeshBasicMaterial({ color: 0x8aa6cc, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
      const fill = new THREE.Mesh(new THREE.CircleGeometry(4.6, 40),
        new THREE.MeshBasicMaterial({ color: 0x8aa6cc, transparent: true, opacity: 0.0, side: THREE.DoubleSide, depthWrite: false }));
      const pulse = new THREE.Mesh(new THREE.RingGeometry(6.4, 7.2, 48),
        new THREE.MeshBasicMaterial({ color: FROST, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
      group.add(ring, fill, pulse);
      ring.position.z = fill.position.z = pulse.position.z = 0.6;
      this.scene.add(group);
      const label = this._label(`${s.side} ${s.region}`, pos.clone().multiplyScalar(1.13), null, normal);
      this.spots.set(s.id, { group, ring, fill, pulse, normal, pos, label, state: 'pending' });
    }
  }

  // state: pending | active | done | flagged ; value: this spot minus its mirror, in standard errors
  setSpotState(id, state, value = 0) {
    const s = this.spots.get(id);
    if (!s) return;
    s.state = state;
    const warm = new THREE.Color('#ee6b3b'), cool = new THREE.Color('#5d7fb8'), mid = new THREE.Color('#8a97ab');
    if (state === 'done' || state === 'flagged') {
      const t = Math.max(-1, Math.min(1, value / 4));
      const col = t >= 0 ? mid.clone().lerp(warm, t) : mid.clone().lerp(cool, -t);
      s.fill.material.color.copy(col);
      s.fill.material.opacity = 0.9;
      s.ring.material.color.set(state === 'flagged' ? '#f2b84b' : '#c9d6ea');
    } else {
      s.fill.material.opacity = 0;
      s.ring.material.color.set(state === 'active' ? FROST : new THREE.Color('#8aa6cc'));
    }
  }

  _probe() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 34, 40, 1, false),
      new THREE.MeshStandardMaterial({ color: 0x223452, roughness: 0.35, metalness: 0.5 }));
    body.rotation.x = Math.PI / 2;
    body.position.z = 17;
    const face = new THREE.Mesh(new THREE.CircleGeometry(8.2, 40), new THREE.MeshBasicMaterial({ color: 0x6fb7f0 }));
    face.position.z = 0.2;
    face.rotation.y = Math.PI;
    const beamGeo = new THREE.ConeGeometry(14, 40, 40, 1, true);
    beamGeo.translate(0, -20, 0);
    const beam = new THREE.Mesh(beamGeo, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uOn: { value: 0 } },
      vertexShader: 'varying float vY; void main(){ vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform float uOn; varying float vY; void main(){ float a = smoothstep(-40.0, 0.0, vY); gl_FragColor = vec4(vec3(1.0,0.32,0.22) * a * 0.55 * uOn, 1.0); }',
    }));
    beam.rotation.x = -Math.PI / 2;
    g.add(body, face, beam);
    g.visible = false;
    this.scene.add(g);
    this.probe.group = g;
    this.probe.beam = beam;
  }

  setProbe(status) {
    if (!status || !status.spot || !this.spots.has(status.spot)) {
      this.probe.group.visible = false;
      return;
    }
    const s = this.spots.get(status.spot);
    this.probe.group.visible = true;
    this.probe.onHead = status.on_head;
    this.probe.normal = s.normal;
    this.probe.target = s.pos.clone().add(s.normal.clone().multiplyScalar(status.on_head ? 0.5 : 26));
    for (const [id, sp] of this.spots) {
      if (sp.state === 'pending' || sp.state === 'active') this.setSpotState(id, id === status.spot ? 'active' : 'pending');
    }
  }

  _swarm() {
    const geo = new THREE.BufferGeometry();
    this.swarm = {
      from: new Float32Array(N_SIMS * 3), to: new Float32Array(N_SIMS * 3), pos: new Float32Array(N_SIMS * 3),
      kindFrom: new Float32Array(N_SIMS), kindTo: new Float32Array(N_SIMS), kind: new Float32Array(N_SIMS),
      delay: new Float32Array(N_SIMS), start: 0, shell: [],
    };
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N_SIMS; i++) {
      const y = 1 - (i / (N_SIMS - 1)) * 2, r = Math.sqrt(1 - y * y), a = i * golden;
      const p = new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, y * 0.9).normalize().multiplyScalar(R * 1.24 + (i % 7));
      this.swarm.shell.push(p);
      this.swarm.to.set([p.x, p.y, p.z], i * 3);
      this.swarm.delay[i] = Math.random() * 0.6;
    }
    this.swarm.from.set(this.swarm.to);
    this.swarm.pos.set(this.swarm.to);
    geo.setAttribute('position', new THREE.BufferAttribute(this.swarm.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('kind', new THREE.BufferAttribute(this.swarm.kind, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uFrost: { value: FROST }, uEmber: { value: EMBER }, uPx: { value: 1 } },
      vertexShader: `attribute float kind; uniform float uTime; uniform float uPx; varying float vKind;
        void main() {
          vKind = kind;
          // Healthy heads drift slowly around the scalp; bleed heads sit still where they put the bleed.
          float a = uTime * 0.06 * (1.0 - kind);
          vec3 p = vec3(position.x * cos(a) - position.y * sin(a), position.x * sin(a) + position.y * cos(a), position.z);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = mix(2.4, 4.2, kind) * uPx * (420.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `uniform vec3 uFrost; uniform vec3 uEmber; varying float vKind;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(mix(uFrost * 0.55, uEmber * 0.9, vKind) * a, 1.0);
        }`,
    });
    this.swarm.points = new THREE.Points(geo, mat);
    this.scene.add(this.swarm.points);
  }

  // bleed: 0/1 per simulated head; points: [x,y,z] for each bleed head, in order
  setSims(bleed, points) {
    const sw = this.swarm;
    sw.from.set(sw.pos);
    sw.kindFrom.set(sw.kind);
    let k = 0;
    for (let i = 0; i < N_SIMS; i++) {
      const isBleed = bleed[i] === 1 && k < points.length;
      let p;
      if (isBleed) {
        const q = points[k++];
        p = new THREE.Vector3(q[0] + (Math.random() - 0.5) * 7, q[1] + (Math.random() - 0.5) * 7, q[2] + (Math.random() - 0.5) * 7);
      } else {
        p = sw.shell[i];
      }
      sw.to.set([p.x, p.y, p.z], i * 3);
      sw.kindTo[i] = isBleed ? 1 : 0;
    }
    sw.start = this.clock.elapsedTime;
  }

  _cloud() {
    const max = 2000;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    geo.setAttribute('blood', new THREE.BufferAttribute(new Float32Array(max), 1));
    geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uFade: { value: 0 }, uPx: { value: 1 } },
      vertexShader: `attribute float blood; uniform float uPx; varying float vB;
        void main() { vB = blood; vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = (3.0 + 9.0 * blood) * uPx * (420.0 / -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `${RAMP_GLSL} uniform float uFade; varying float vB;
        void main() { float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.05, d);
          gl_FragColor = vec4(bloodRamp(vB) * a * (0.12 + 0.55 * vB) * uFade, 1.0); }`,
    });
    this.cloud = { points: new THREE.Points(geo, mat), max, start: -10 };
    this.scene.add(this.cloud.points);
  }

  setCloud(voxels) {
    const geo = this.cloud.points.geometry;
    const pos = geo.attributes.position.array, blood = geo.attributes.blood.array;
    const list = voxels.filter((v) => v.blood >= 0.04).slice(0, this.cloud.max);
    // Scatter each voxel within its 5 mm cell so the cloud doesn't show the grid.
    const wobble = (i, k) => { const s = Math.sin((i + 1) * (12.9898 + k * 78.233)) * 43758.5453; return (s - Math.floor(s) - 0.5) * 5; };
    list.forEach((v, i) => { pos.set([v.x + wobble(i, 0), v.y + wobble(i, 1), v.z + wobble(i, 2)], i * 3); blood[i] = v.blood; });
    geo.attributes.position.needsUpdate = true;
    geo.attributes.blood.needsUpdate = true;
    geo.setDrawRange(0, list.length);
    this.cloud.start = this.clock.elapsedTime;
  }

  _truth() {
    this.truth = new THREE.Group();
    this.truth.visible = false;
    this.scene.add(this.truth);
  }

  setTruth(truth) {
    this.truth.clear();
    if (!truth) return;
    const normal = new THREE.Vector3(...truth.normal);
    const edge = new THREE.Vector3(...truth.near_edge);
    const radius = Math.max(truth.spread_mm, truth.thickness_mm / 2, 6);
    const pts = [];
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
    }
    const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 3, gapSize: 2.5, transparent: true, opacity: 0.85 }));
    ring.computeLineDistances();
    ring.position.copy(edge);
    ring.lookAt(edge.clone().add(normal));
    const depth = new THREE.Line(new THREE.BufferGeometry().setFromPoints([edge, edge.clone().sub(normal.clone().multiplyScalar(truth.thickness_mm))]),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }));
    this.truth.add(ring, depth);
  }

  showTruth(on) { this.truth.visible = on; }

  focus(point) {
    // Swing the camera round to face the likely bleed, once, unless the viewer has taken over.
    if (!point || !this.controls.autoRotate) return;
    this.controls.autoRotate = false;
    const dir = new THREE.Vector3(...point).normalize();
    const dist = this.camera.position.length();
    this.camFrom = this.camera.position.clone();
    this.camTo = dir.multiplyScalar(dist).add(new THREE.Vector3(0, 0, dist * 0.25)).setLength(dist);
    this.camStart = this.clock.elapsedTime;
  }

  resize() {
    const el = this.canvas.parentElement;
    const w = el.clientWidth, h = el.clientHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Keep the whole head in view on tall, narrow screens.
    const dist = 480 * Math.max(1, 1.05 / this.camera.aspect);
    if (!this.userZoomed) this.camera.position.setLength(dist);
    this.controls.maxDistance = Math.max(900, dist * 1.5);
    const px = this.renderer.getPixelRatio() * (h / 700);
    this.swarm.points.material.uniforms.uPx.value = px;
    this.cloud.points.material.uniforms.uPx.value = px;
  }

  frame() {
    const t = this.clock.getElapsedTime();
    const sw = this.swarm;
    // Swarm flights: each simulated head flies on an arc to its new place.
    const dur = REDUCED ? 0.001 : 1.6;
    let moving = false;
    for (let i = 0; i < N_SIMS; i++) {
      const u = Math.min(1, Math.max(0, (t - sw.start - sw.delay[i]) / dur));
      if (u < 1) moving = true;
      const e = ease(u), lift = Math.sin(Math.PI * e) * 18;
      for (let k = 0; k < 3; k++) {
        const a = sw.from[i * 3 + k], b = sw.to[i * 3 + k];
        sw.pos[i * 3 + k] = a + (b - a) * e;
      }
      const len = Math.hypot(sw.pos[i * 3], sw.pos[i * 3 + 1], sw.pos[i * 3 + 2]) || 1;
      for (let k = 0; k < 3; k++) sw.pos[i * 3 + k] *= (len + lift) / len;
      sw.kind[i] = sw.kindFrom[i] + (sw.kindTo[i] - sw.kindFrom[i]) * e;
    }
    if (moving || t - sw.start < 3) {
      sw.points.geometry.attributes.position.needsUpdate = true;
      sw.points.geometry.attributes.kind.needsUpdate = true;
    }
    sw.points.material.uniforms.uTime.value = t;
    this.cloud.points.material.uniforms.uFade.value = Math.min(1, (t - this.cloud.start) / 1.2);

    if (this.heat) {
      let changed = false;
      const { current, target } = this.heat;
      for (let i = 0; i < current.length; i++) {
        const d = target[i] - current[i];
        if (Math.abs(d) > 0.002) { current[i] += d * 0.05; changed = true; }
      }
      if (changed) {
        this.heat.attrs.forEach((attr, h) => {
          attr.array.set(current.subarray(this.heat.offsets[h], this.heat.offsets[h] + attr.count));
          attr.needsUpdate = true;
        });
      }
    }

    const pr = this.probe;
    if (pr.group.visible) {
      const bob = pr.onHead ? 0 : Math.sin(t * 2) * 2;
      const tgt = pr.target.clone().add(pr.normal.clone().multiplyScalar(bob));
      pr.group.position.lerp(tgt, REDUCED ? 1 : 0.12);
      pr.group.lookAt(pr.group.position.clone().add(pr.normal));
      const on = pr.beam.material.uniforms.uOn;
      on.value += ((pr.onHead ? 1 : 0) - on.value) * 0.1;
    }
    for (const s of this.spots.values()) {
      if (s.state === 'active') {
        const k = (t * 0.8) % 1;
        s.pulse.scale.setScalar(1 + k * 1.2);
        s.pulse.material.opacity = (1 - k) * 0.8;
      } else {
        s.pulse.material.opacity = 0;
      }
    }
    if (this.camTo) {
      const u = Math.min(1, (t - this.camStart) / 2.2);
      this.camera.position.copy(this.camFrom).lerp(this.camTo, ease(u)).setLength(this.camFrom.length());
      if (u >= 1) this.camTo = null;
    }
    this.controls.update();
    this.composer.render();
    this._placeLabels();
  }

  _placeLabels() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const camDir = this.camera.position.clone().normalize();
    for (const l of this.labels) {
      const p = l.pos.clone().project(this.camera);
      l.el.style.left = `${((p.x + 1) / 2) * w}px`;
      l.el.style.top = `${((1 - p.y) / 2) * h}px`;
      const facing = l.normal ? l.normal.dot(camDir) : 1;
      l.el.style.opacity = facing > 0.05 ? Math.min(1, facing * 2.5) : 0;
    }
  }
}
