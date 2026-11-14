import * as THREE from "three";
import { heatRGB } from "@/components/ui";
import { decodeCortex, CORTEX_URL } from "./brain-model";
import { heatAttributes, scalpSpot3D } from "./brain-heat";
import type { ScanUpdate } from "./types";
import { DEFAULT_FOLDING, scanRevealRadius, surfaceNormals, type CortexModel, type FoldingParameters } from "./brain-geometry";

import { DEFAULT_SEED } from "./brain-anatomy";

const VIEW = 1.25;
const vertexShader = `
  uniform float depth;
  attribute vec3 delta;
  attribute vec3 foldNormal;
  attribute vec3 deepNormal;
  attribute float sulc;
  attribute float heat;
  attribute float before;
  attribute float after;
  attribute vec3 head;
  varying float vHeat;
  varying float vBefore;
  varying float vAfter;
  varying vec3 vHead;
  varying vec3 vNormal;
  varying vec3 vPosition;
  varying float vSulc;
  void main() {
    vec3 n = depth < 1.0 ? mix(normal, foldNormal, depth) : mix(foldNormal, deepNormal, depth - 1.0);
    vNormal = normalize(normalMatrix * normalize(n));
    vPosition = position - delta * (depth <= 1.0 ? depth : 1.0 + (depth - 1.0) * 0.2);
    vSulc = sulc; vHeat = heat; vBefore = before; vAfter = after; vHead = head;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position - delta * (depth <= 1.0 ? depth : 1.0 + (depth - 1.0) * 0.2), 1.0);
  }
`;
const fragmentShader = `
  uniform sampler2D heatRamp;
  uniform vec3 origin;
  uniform float radius;
  uniform float depth;
  varying vec3 vNormal;
  varying vec3 vPosition;
  varying float vSulc;
  varying float vHeat;
  varying float vBefore;
  varying float vAfter;
  varying vec3 vHead;
  vec3 tissue(float coverage, vec3 cortex) {
    float value = vHeat * coverage;
    float alpha = smoothstep(0.2, 0.65, value) * 0.94;
    vec3 heat = texture2D(heatRamp, vec2(clamp((value - 0.15) / 0.75, 0.0, 1.0), 0.5)).rgb;
    // Preserve a little surface shading through the hot region as in the render.
    return mix(cortex * mix(0.20, 1.0, coverage), heat * clamp(dot(cortex, vec3(0.333)) / 0.58, 0.30, 1.0), alpha);
  }
  void main() {
    vec3 n = normalize(vNormal);
    vec3 key = normalize(vec3(-0.6, 0.7, 1.1));
    vec3 rim = normalize(vec3(0.8, -0.4, 0.5));
    float light = 0.36 + 0.66 * max(dot(n, key), 0.0) + 0.06 * max(dot(n, rim), 0.0);
    float groove = smoothstep(0.04, 0.72, vSulc);
    float ao = 1.0 - pow(groove, 1.15) * (0.22 + min(depth, 1.0) * 0.66);
    float crown = 1.0 + 0.09 * (1.0 - vSulc) * max(dot(n, key), 0.0);
    float sheen = 0.08 * pow(max(dot(n, normalize(key + vec3(0.0, 0.0, 1.0))), 0.0), 10.0);
    float midline = 0.014 * sin(vPosition.y * 7.0 + 0.4) + 0.003 * sin(vPosition.y * 19.0);
    float medial = (1.0 - smoothstep(0.006, 0.035, abs(vPosition.x - midline)));
    float flank = mix(0.45, 1.0, smoothstep(-0.15, 0.75, n.z));
    vec3 cortex = (vec3(0.58, 0.64, 0.68) * light * crown + vec3(sheen)) * ao * flank * (1.0 - medial * 0.9);
    float reveal = 1.0 - smoothstep(radius - 1.2, radius + 1.2, distance(vHead, origin));
    gl_FragColor = vec4(mix(tissue(vBefore, cortex), tissue(vAfter, cortex), reveal), 1.0);
  }
`;

/** An imperative, render-on-demand scene; React owns only the controls/overlay. */
export function createBrainScene(canvas: HTMLCanvasElement, overlay: SVGGElement, onReady: () => void, onFailure: () => void, onGenerating: (value: boolean) => void) {
  // Probe on the actual canvas to avoid renderer error logging for a supported fallback.
  const context = canvas.getContext("webgl2", { alpha: true, antialias: true, powerPreference: "low-power" });
  if (!context) throw new Error("WebGL unavailable");
  const renderer = new THREE.WebGLRenderer({ canvas, context, alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.setClearColor(0, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-VIEW, VIEW, VIEW, -VIEW, 0.1, 20);
  camera.position.set(0, 0, 5);
  const group = new THREE.Group();
  scene.add(group);
  const rampBytes = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) { rampBytes.set(heatRGB(i / 255), i * 4); rampBytes[i * 4 + 3] = 255; }
  const ramp = new THREE.DataTexture(rampBytes, 256, 1);
  ramp.minFilter = ramp.magFilter = THREE.LinearFilter;
  ramp.needsUpdate = true;
  const uniforms = {
    heatRamp: { value: ramp }, origin: { value: new THREE.Vector3() }, radius: { value: 300 },
    depth: { value: DEFAULT_FOLDING.depth },
  };
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, side: THREE.FrontSide });
  type Shape = { side: "left" | "right"; delta: Float32Array; sulc: Float32Array; foldNormal: Float32Array; deepNormal: Float32Array; normals?: Float32Array; positions?: Float32Array; faces?: Uint32Array; tangentU?: Float32Array; tangentV?: Float32Array };
  const parts = new Map<string, THREE.BufferGeometry>();
  let disposed = false, ready = false, failed = false, raf = 0;
  let request = 0, activeSeed = DEFAULT_SEED, count = DEFAULT_FOLDING.folding, busy = false;
  let requestedKey = "";
  let previousSpots: number[] = [], finishedSpots: number[] = [];
  const cache = new Map<string, Shape[]>();
  let worker: Worker | undefined, model: CortexModel | undefined, workerInitialized = false, hasEnvelope = false;
  let desiredDepth = DEFAULT_FOLDING.depth;
  let fadeLayer: HTMLCanvasElement | undefined;
  const bases = new Map<string, Pick<Shape, "positions" | "normals" | "faces">>();
  let scanStart = -Infinity, lastTime = performance.now();
  let drag: { id: number; x: number; y: number } | null = null;
  let keyboardHold = false;
  const target = new THREE.Vector2();
  const rotation = new THREE.Vector2();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const abort = new AbortController();

  function fail() {
    if (disposed || failed) return;
    failed = true;
    onFailure();
  }
  renderer.debug.onShaderError = fail;

  function invalidate() {
    if (!disposed && !failed && !raf) raf = requestAnimationFrame(frame);
  }
  function frame(now: number) {
    raf = 0;
    if (disposed || failed || !ready) return;
    const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
    lastTime = now;
    if (!drag && !keyboardHold) target.multiplyScalar(reduced.matches ? 0 : Math.exp(-dt * 3.8));
    rotation.lerp(target, reduced.matches ? 1 : 1 - Math.exp(-dt * 18));
    if (!drag && !keyboardHold && rotation.length() < 0.0001) { target.set(0, 0); rotation.set(0, 0); }
    group.rotation.set(rotation.y, rotation.x, 0);
    group.updateMatrix();
    // Project the existing SVG ring into the same axial plane as the cortex.
    const m = group.matrix.elements;
    overlay.setAttribute("transform", `matrix(${m[0]} ${-m[1]} ${-m[4]} ${m[5]} ${m[8] * 0.08} ${-m[9] * 0.08})`);
    uniforms.radius.value = scanRevealRadius(now - scanStart, reduced.matches) * 100;
    try { renderer.render(scene, camera); } catch { fail(); return; }
    if (uniforms.radius.value < 300 || rotation.length() > 0 || drag) invalidate();
  }
  function resize() {
    const size = canvas.clientWidth;
    if (!size) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(size, size, false);
    invalidate();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  function down(event: PointerEvent) {
    if (event.button !== 0 || drag) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = "grabbing";
    invalidate();
  }
  function move(event: PointerEvent) {
    if (!drag || drag.id !== event.pointerId) return;
    const scale = 2.4 / Math.max(1, canvas.clientWidth);
    // Combined limits stay above the horizontal plane (maximum polar tilt ~74°).
    target.x = THREE.MathUtils.clamp(target.x + (event.clientX - drag.x) * scale, -1.2, 1.2);
    target.y = THREE.MathUtils.clamp(target.y + (event.clientY - drag.y) * scale, -0.7, 0.7);
    drag.x = event.clientX; drag.y = event.clientY;
    invalidate();
  }
  function up(event: PointerEvent) {
    if (event.pointerId !== drag?.id) return;
    drag = null;
    canvas.style.cursor = "grab";
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    invalidate();
  }
  function key(event: KeyboardEvent) {
    const directions: Record<string, [number, number]> = { ArrowLeft: [-0.25, 0], ArrowRight: [0.25, 0], ArrowUp: [0, -0.25], ArrowDown: [0, 0.25] };
    if (event.key === "Home") { keyboardHold = false; target.set(0, 0); rotation.set(0, 0); }
    else if (directions[event.key]) { keyboardHold = true; target.fromArray(directions[event.key]); rotation.copy(target); }
    else return;
    event.preventDefault(); invalidate();
  }
  function releaseKey() { keyboardHold = false; invalidate(); }
  function contextLost(event: Event) { event.preventDefault(); fail(); }
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("lostpointercapture", up);
  canvas.addEventListener("keydown", key);
  canvas.addEventListener("keyup", releaseKey);
  canvas.addEventListener("blur", releaseKey);
  canvas.addEventListener("webglcontextlost", contextLost);
  reduced.addEventListener("change", invalidate);

  function applyHeat(geometry: THREE.BufferGeometry) {
    const data = heatAttributes(geometry.getAttribute("position").array, previousSpots, finishedSpots);
    for (const key of ["heat", "before", "after", "head"] as const) {
      const attribute = geometry.getAttribute(key) as THREE.BufferAttribute | undefined;
      if (attribute) { (attribute.array as Float32Array).set(data[key]); attribute.needsUpdate = true; }
      else geometry.setAttribute(key, new THREE.BufferAttribute(data[key], key === "head" ? 3 : 1));
    }
  }
  function crossfade() {
    fadeLayer?.remove();
    if (!ready || reduced.matches) return;
    renderer.render(scene, camera);
    const layer = document.createElement("canvas");
    layer.width = canvas.width; layer.height = canvas.height;
    layer.className = "absolute inset-0 size-full pointer-events-none";
    layer.setAttribute("aria-hidden", "true");
    layer.getContext("2d")?.drawImage(canvas, 0, 0);
    canvas.after(layer); fadeLayer = layer;
    layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, easing: "ease-out" }).onfinish = () => { layer.remove(); if (fadeLayer === layer) fadeLayer = undefined; };
  }
  function installPattern(shapes: Shape[], transition = true) {
    if (transition) crossfade();
    for (const shape of shapes) {
      let geometry = parts.get(shape.side);
      if (shape.positions) bases.set(shape.side, shape);
      const base = bases.get(shape.side);
      if (!geometry) {
        geometry = new THREE.BufferGeometry();
        geometry.setIndex(new THREE.BufferAttribute(shape.faces!, 1));
        geometry.setAttribute("position", new THREE.BufferAttribute(shape.positions!, 3));
        geometry.setAttribute("normal", new THREE.BufferAttribute(shape.normals!, 3));
        geometry.computeBoundingSphere();
        parts.set(shape.side, geometry);
        applyHeat(geometry);
        group.add(new THREE.Mesh(geometry, material));
      }
      if (base) {
        for (const key of ["position", "normal"] as const) {
          const attribute = geometry.getAttribute(key) as THREE.BufferAttribute;
          (attribute.array as Float32Array).set(key === "position" ? base.positions! : base.normals!); attribute.needsUpdate = true;
        }
        applyHeat(geometry);
      }
      for (const key of ["delta", "foldNormal", "deepNormal", "sulc"] as const) {
        const attribute = geometry.getAttribute(key) as THREE.BufferAttribute | undefined;
        if (attribute) { (attribute.array as Float32Array).set(shape[key]); attribute.needsUpdate = true; }
        else geometry.setAttribute(key, new THREE.BufferAttribute(shape[key].slice(), key === "sulc" ? 1 : 3).setUsage(THREE.DynamicDrawUsage));
      }
    }
    invalidate();
  }
  function receivePattern(event: MessageEvent<{ request: number; seed: number; count: number; error?: string; parts: Shape[]; generationMs: number; envelopeMs: number }>) {
    if (disposed || failed || event.data.request !== request) return;
    if (event.data.error) { fail(); return; }
    const { parts: shapes, generationMs, envelopeMs } = event.data;
    busy = false;
    for (const shape of shapes) if (shape.positions) bases.set(shape.side, shape);
    hasEnvelope = true;
    const completedKey = `${event.data.seed}:${event.data.count}`;
    cache.set(completedKey, shapes);
    if (cache.size > 8) cache.delete(cache.keys().next().value!);
    if (completedKey !== `${activeSeed}:${count}` && ready) { requestPattern(); return; }
    installPattern(shapes);
    uniforms.depth.value = desiredDepth;
    canvas.dataset.foldCount = String(event.data.count);
    canvas.dataset.generationMs = generationMs.toFixed(1);
    canvas.dataset.envelopeMs = envelopeMs.toFixed(1);
    canvas.dataset.seed = String(event.data.seed);
    ready = true;
    resize();
    renderer.compile(scene, camera);
    if (failed) return;
    onGenerating(false); invalidate();
    if (completedKey !== `${activeSeed}:${count}`) requestPattern();
  }
  function requestPattern() {
    if (!ready || !model || disposed || failed) return;
    const key = `${activeSeed}:${count}`;
    const cached = cache.get(key);
    if (cached) {
      installPattern(cached); uniforms.depth.value = desiredDepth; onGenerating(false); requestedKey = key;
      canvas.dataset.seed = String(activeSeed); canvas.dataset.foldCount = String(count); canvas.dataset.generationMs = "0";
    } else {
      onGenerating(true);
      if (busy) return;
      busy = true; requestedKey = key;
      try {
        if (!worker) {
          worker = new Worker(new URL("./brain-cortex.worker.ts", import.meta.url), { type: "module" });
          worker.onerror = fail; worker.onmessage = receivePattern;
        }
        worker.postMessage({ seed: activeSeed, count, model: workerInitialized ? undefined : model, request: ++request });
        workerInitialized = true;
      } catch { fail(); }
    }
  }
  fetch(CORTEX_URL, { signal: abort.signal })
    .then((response) => { if (!response.ok) throw new Error("Cortex model unavailable"); return response.arrayBuffer(); })
    .then((buffer) => {
      if (disposed) return;
      const asset = decodeCortex(buffer); model = asset.model;
      const baked = (["left", "right"] as const).map((side) => {
        const { positions, sulc } = asset.baked[side], faces = Uint32Array.from(asset.model[side].faces), normals = surfaceNormals(positions, faces);
        return { side, positions, faces, normals, sulc, delta: new Float32Array(positions.length), foldNormal: normals, deepNormal: normals };
      });
      installPattern(baked, false);
      bases.clear();
      ready = true; resize(); renderer.compile(scene, camera); renderer.render(scene, camera);
      if (failed) return;
      canvas.dataset.firstFrameMs = performance.now().toFixed(1);
      canvas.dataset.generationMs = "0"; canvas.dataset.seed = String(DEFAULT_SEED); canvas.dataset.foldCount = String(DEFAULT_FOLDING.folding);
      requestedKey = `${DEFAULT_SEED}:${DEFAULT_FOLDING.folding}`;
      onGenerating(false); onReady(); invalidate();
      if (count !== DEFAULT_FOLDING.folding || desiredDepth !== DEFAULT_FOLDING.depth || activeSeed !== DEFAULT_SEED) requestPattern();
    })
    .catch(fail);

  return {
    setParameters(next: FoldingParameters) {
      count = Math.round(next.folding * 100) / 100;
      desiredDepth = next.depth;
      if (requestedKey !== `${activeSeed}:${count}` || (!hasEnvelope && next.depth !== DEFAULT_FOLDING.depth)) requestPattern();
      if (hasEnvelope) uniforms.depth.value = desiredDepth;
      invalidate();
    },
    regenerate(seed: number) {
      if (!ready || disposed || failed) return;
      activeSeed = seed >>> 0;
      requestPattern();
    },
    setScan(scan: ScanUpdate | null, spots: number[]) {
      if (spots.join(",") === finishedSpots.join(",")) return;
      previousSpots = scan ? finishedSpots : [];
      finishedSpots = scan ? spots : [];
      for (const geometry of parts.values()) applyHeat(geometry);
      uniforms.origin.value.fromArray(scalpSpot3D(scan?.spot ?? 0));
      scanStart = scan ? performance.now() : -Infinity;
      invalidate();
    },
    resetView() {
      if (drag && canvas.hasPointerCapture(drag.id)) canvas.releasePointerCapture(drag.id);
      drag = null; keyboardHold = false; canvas.style.cursor = "grab";
      target.set(0, 0); invalidate();
    },
    dispose() {
      disposed = true;
      abort.abort();
      worker?.terminate();
      fadeLayer?.remove();
      cancelAnimationFrame(raf);
      observer.disconnect();
      reduced.removeEventListener("change", invalidate);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("lostpointercapture", up);
      canvas.removeEventListener("keydown", key);
      canvas.removeEventListener("keyup", releaseKey);
      canvas.removeEventListener("blur", releaseKey);
      canvas.removeEventListener("webglcontextlost", contextLost);
      parts.forEach((geometry) => geometry.dispose());
      ramp.dispose();
      const loseContext = context.getExtension("WEBGL_lose_context");
      material.dispose(); renderer.dispose();
      // Strict Mode reuses this canvas for its second setup. Only release the
      // context once React has actually detached it, not during that rehearsal.
      queueMicrotask(() => { if (!canvas.isConnected) loseContext?.loseContext(); });
    },
  };
}
