// The race in 3D: every simulated bleed sits where it really was in a glass head, dark until the scan finds
// it. As the race moves pair by pair, the pair under the probe glows on the scalp and each bleed ignites at
// the moment its patient's chance of bleed passes 50%. The ones left dark are the misses.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const R = 90;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const HOLO = 'uniform vec3 uColor; uniform float uBase; uniform float uRim; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 2.4); gl_FragColor = vec4(uColor * (uBase + uRim * f), 1.0); }';
const HOLO_V = 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }';

const holo = (color, base, rim) => new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { uColor: { value: new THREE.Color(color) }, uBase: { value: base }, uRim: { value: rim } },
  vertexShader: HOLO_V, fragmentShader: HOLO,
});

export class RaceHead {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0d1626');
    this.camera = new THREE.PerspectiveCamera(32, 1, 1, 3000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(-300, 330, 170);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.enableZoom = false;
    this.controls.autoRotate = !REDUCED;
    this.controls.autoRotateSpeed = 0.7;
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; });
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.5, 0.5));
    this.composer.addPass(new OutputPass());

    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(R, 72, 48), holo('#6fb7f0', 0.015, 0.5)));
    const nose = new THREE.Mesh(new THREE.ConeGeometry(7, 18, 24), holo('#6fb7f0', 0.25, 0.4));
    nose.position.set(0, R + 6, -6);
    nose.rotation.x = -Math.PI / 2;
    this.scene.add(nose);
    this.spots = [];
    this.bleeds = null;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  async loadBrain(url) {
    const data = await (await fetch(url)).json();
    const mat = holo('#4e98da', 0.03, 0.42);
    for (const side of ['left', 'right']) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(data[side].vertices, 3));
      geo.setIndex(data[side].faces);
      geo.computeVertexNormals();
      this.scene.add(new THREE.Mesh(geo, mat));
    }
  }

  setSpots(ids) {
    // The ten scan spots, in scan order, as rings on the scalp.
    const REG = { frontal: [30, 35], frontotemporal: [60, 15], temporal: [90, 10], parietal: [100, 50], occipital: [155, 15] };
    for (const id of ids) {
      const [side, region] = id.split('-');
      const [az0, el0] = REG[region];
      const az = THREE.MathUtils.degToRad(az0) * (side === 'R' ? 1 : -1), el = THREE.MathUtils.degToRad(el0);
      const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el));
      const ring = new THREE.Mesh(new THREE.RingGeometry(6, 8.5, 40),
        new THREE.MeshBasicMaterial({ color: 0x6fb7f0, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
      ring.position.copy(dir.clone().multiplyScalar(R + 0.5));
      ring.lookAt(dir.clone().multiplyScalar(2 * R));
      this.scene.add(ring);
      this.spots.push(ring);
    }
  }

  setPatients(patients) {
    // One glowing point per simulated bleed, nudged around its spot so a cluster reads as a cluster.
    const list = patients.filter((p) => p.bleed && p.pos);
    const n = list.length;
    const pos = new Float32Array(n * 3), size = new Float32Array(n), lit = new Float32Array(n), dim = new Float32Array(n), hot = new Float32Array(n);
    list.forEach((p, i) => {
      const v = new THREE.Vector3(...p.pos);
      const tangent = new THREE.Vector3(Math.sin(i * 12.9898), Math.cos(i * 78.233), Math.sin(i * 39.425)).cross(v).normalize();
      v.addScaledVector(tangent, ((i * 7919) % 17 - 8) * 1.1);
      pos.set([v.x, v.y, v.z], i * 3);
      size[i] = 3 + Math.sqrt(p.volume) * 1.1;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    for (const [name, arr] of [['aLit', lit], ['aDim', dim], ['aHot', hot]]) geo.setAttribute(name, new THREE.BufferAttribute(arr, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
      uniforms: { uPx: { value: 1 } },
      vertexShader: `attribute float aSize; attribute float aLit; attribute float aDim; attribute float aHot; uniform float uPx;
        varying float vLit; varying float vDim; varying float vHot;
        void main() { vLit = aLit; vDim = aDim; vHot = aHot;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * 0.8 * (1.0 + 1.6 * aHot) * uPx * (460.0 / -mv.z);
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vLit; varying float vDim; varying float vHot;
        void main() { float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
          float core = smoothstep(0.5, 0.0, d), ring = smoothstep(0.08, 0.0, abs(d - 0.38));
          vec3 ember = vec3(1.0, 0.45, 0.2), ash = vec3(0.35, 0.45, 0.6);
          vec3 c = mix(ash * ring * 0.6, ember * (core * 0.75 + ring * 0.35) + vec3(1.0, 0.85, 0.6) * core * vHot * 1.4, vLit);
          gl_FragColor = vec4(c * vDim, 1.0); }`,
    });
    if (this.bleeds) this.scene.remove(this.bleeds.points);
    this.bleeds = { points: new THREE.Points(geo, mat), list, lit, dim, hot, geo };
    this.scene.add(this.bleeds.points);
    this.resize();
  }

  setLive(point) {
    if (!this.live) {
      this.live = new THREE.Mesh(new THREE.TorusGeometry(9, 1.2, 12, 48), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      this.scene.add(this.live);
    }
    this.live.visible = !!point;
    if (point) {
      const v = new THREE.Vector3(...point);
      this.live.position.copy(v);
      this.live.lookAt(v.clone().multiplyScalar(2));
    }
  }

  // progress: spots read so far in the race (0..10, fractional); matches(p): highlighted; hover: a patient or null
  frame(progress, matches, hover, t) {
    if (this.bleeds) {
      const { list, lit, dim, hot, geo } = this.bleeds;
      list.forEach((p, i) => {
        const at = p.curve.findIndex((v) => v >= 0.5);
        const on = at > 0 && progress >= at;
        lit[i] = on ? 1 : 0;
        hot[i] = on ? Math.max(0, 1 - (progress - at) / 0.8) : 0;  // the flash when it ignites
        dim[i] = (matches(p) ? 1 : 0.08) * (hover && hover !== p ? 0.25 : 1) * (hover === p ? 1.6 : 1);
      });
      for (const name of ['aLit', 'aDim', 'aHot']) geo.attributes[name].needsUpdate = true;
    }
    // The pair under the probe glows.
    const pair = Math.floor((Math.max(1, Math.ceil(progress)) - 1) / 2);  // spots are read left then right
    this.spots.forEach((ring, i) => {
      const active = progress < 10 && Math.floor(i / 2) === pair;
      ring.material.opacity = active ? 0.95 : progress >= i + 1 ? 0.45 : 0.18;
      ring.scale.setScalar(active ? 1.3 + 0.2 * Math.sin(t * 8) : 1);
    });
    if (this.live && this.live.visible) this.live.scale.setScalar(1 + 0.12 * Math.sin(t * 4));
    this.controls.update();
    this.composer.render();
  }

  resize() {
    const el = this.canvas.parentElement, w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.camera.position.setLength(470 * Math.max(1, 1.05 / this.camera.aspect));
    if (this.bleeds) this.bleeds.points.material.uniforms.uPx.value = this.renderer.getPixelRatio() * (h / 420);
  }
}
