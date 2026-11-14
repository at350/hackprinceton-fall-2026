import * as THREE from "three";
import { heatRGB } from "@/components/ui";
import { pointAt } from "./mock";
import type { ScanUpdate } from "./types";
import { DEFAULT_FOLDING, deformHemisphere, prepareHemisphere, scanRevealRadius, surfaceNormals, toDisplayPositions, type CortexModel, type FoldingParameters } from "./brain-geometry";

const VIEW = 1.25;
const vertexShader = `
  attribute float sulc;
  varying vec3 vNormal;
  varying vec3 vPosition;
  varying float vSulc;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vPosition = position;
    vSulc = sulc;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const fragmentShader = `
  uniform sampler2D previousMap;
  uniform sampler2D nextMap;
  uniform sampler2D heatRamp;
  uniform vec2 origin;
  uniform float radius;
  uniform float folding;
  uniform float depth;
  varying vec3 vNormal;
  varying vec3 vPosition;
  varying float vSulc;
  vec3 tissue(float value, vec3 cortex) {
    float coverage = clamp(value / 0.06, 0.0, 1.0);
    float alpha = smoothstep(0.2, 0.65, value) * 0.94;
    vec3 heat = texture2D(heatRamp, vec2(clamp((value - 0.15) / 0.75, 0.0, 1.0), 0.5)).rgb;
    // Preserve a little surface shading through the hot region as in the render.
    return mix(cortex * mix(0.20, 1.0, coverage), heat, alpha);
  }
  float grain(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    vec3 c = vec3(127.1, 311.7, 74.7);
    float a = dot(i, c);
    return mix(mix(mix(fract(sin(a) * 43758.5453), fract(sin(a+c.x) * 43758.5453), f.x),
                   mix(fract(sin(a+c.y) * 43758.5453), fract(sin(a+c.x+c.y) * 43758.5453), f.x), f.y),
               mix(mix(fract(sin(a+c.z) * 43758.5453), fract(sin(a+c.x+c.z) * 43758.5453), f.x),
                   mix(fract(sin(a+c.y+c.z) * 43758.5453), fract(sin(a+c.x+c.y+c.z) * 43758.5453), f.x), f.y), f.z);
  }
  void main() {
    vec3 n = normalize(vNormal);
    vec3 key = normalize(vec3(-0.6, 0.7, 1.1));
    vec3 rim = normalize(vec3(0.8, -0.4, 0.5));
    float light = 0.36 + 0.72 * max(dot(n, key), 0.0) + 0.10 * max(dot(n, rim), 0.0);
    // Closed sulci read as narrow clefts, not broad missing bands of tissue.
    // At the deepest setting the original pial valleys become visible again.
    float opening = smoothstep(1.0, 2.0, depth);
    float groove = pow(smoothstep(mix(0.25, 0.35, opening), mix(0.65, 0.95, opening), vSulc), mix(3.0, 1.0, opening));
    float ao = 1.0 - groove * folding * (0.45 + min(depth, 1.0) * 0.20);
    // Diffuse crown lift, not a specular highlight: the cortex stays matte.
    float crown = 1.0 + 0.11 * (1.0 - smoothstep(0.15, 0.45, vSulc)) * folding * max(dot(n, key), 0.0);
    // Fine, stationary tissue texture, separate from the anatomical folds.
    float tissueGrain = 0.95 + 0.10 * grain(vPosition * 230.0);
    vec3 cortex = vec3(0.56, 0.65, 0.70) * light * ao * crown * tissueGrain;
    vec2 mapPosition = vec2(vPosition.x, -vPosition.y);
    // The anatomical silhouette is not a perfect ellipse. Extend the nearest
    // in-mask sample to its rim instead of exposing a jagged, unscanned border.
    mapPosition /= max(1.0, length(mapPosition / vec2(0.676, 0.92)) / 0.94);
    vec2 uv = (mapPosition + 1.0) * 0.5;
    // Grid endpoints are at ±1, not at the edges of the outermost texels.
    uv = (uv * 63.0 + 0.5) / 64.0;
    float before = texture2D(previousMap, uv).r;
    float after = texture2D(nextMap, uv).r;
    float reveal = 1.0 - smoothstep(radius - 0.012, radius + 0.012, distance(mapPosition, origin));
    gl_FragColor = vec4(mix(tissue(before, cortex), tissue(after, cortex), reveal), 1.0);
  }
`;

function mapTexture(scan: ScanUpdate | null) {
  const bytes = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    bytes[(y * 64 + x) * 4] = Math.round((scan?.map[y]?.[x] ?? 0) * 255);
    bytes[(y * 64 + x) * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(bytes, 64, 64);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** An imperative, render-on-demand scene; React owns only the controls/overlay. */
export function createBrainScene(canvas: HTMLCanvasElement, overlay: SVGGElement, onReady: () => void, onFailure: () => void) {
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
    previousMap: { value: mapTexture(null) }, nextMap: { value: mapTexture(null) },
    heatRamp: { value: ramp }, origin: { value: new THREE.Vector2() }, radius: { value: 3 },
    folding: { value: DEFAULT_FOLDING.folding }, depth: { value: DEFAULT_FOLDING.depth },
  };
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader });
  const parts: { prepared: ReturnType<typeof prepareHemisphere>; geometry: THREE.BufferGeometry; mm: Float32Array; side: "left" | "right" }[] = [];
  let parameters: FoldingParameters = { ...DEFAULT_FOLDING };
  let disposed = false, ready = false, failed = false, raf = 0, geometryDirty = true;
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
    if (geometryDirty) {
      for (const part of parts) {
        deformHemisphere(part.prepared, parameters, part.mm);
        const position = part.geometry.getAttribute("position") as THREE.BufferAttribute;
        const normal = part.geometry.getAttribute("normal") as THREE.BufferAttribute;
        toDisplayPositions(part.mm, part.side, position.array as Float32Array);
        surfaceNormals(position.array, part.prepared.source.faces, normal.array as Float32Array);
        position.needsUpdate = normal.needsUpdate = true;
        part.geometry.computeBoundingSphere();
      }
      geometryDirty = false;
    }
    if (!drag && !keyboardHold) target.multiplyScalar(reduced.matches ? 0 : Math.exp(-dt * 3.8));
    rotation.lerp(target, reduced.matches ? 1 : 1 - Math.exp(-dt * 18));
    if (!drag && !keyboardHold && rotation.length() < 0.0001) { target.set(0, 0); rotation.set(0, 0); }
    group.rotation.set(rotation.y, rotation.x, 0);
    group.updateMatrix();
    // Project the existing SVG ring into the same axial plane as the cortex.
    const m = group.matrix.elements;
    overlay.setAttribute("transform", `matrix(${m[0]} ${-m[1]} ${-m[4]} ${m[5]} ${m[8] * 0.08} ${-m[9] * 0.08})`);
    uniforms.radius.value = scanRevealRadius(now - scanStart, reduced.matches);
    try { renderer.render(scene, camera); } catch { fail(); return; }
    if (uniforms.radius.value < 3 || rotation.length() > 0 || drag) invalidate();
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
    target.x = THREE.MathUtils.clamp(target.x + (event.clientX - drag.x) * scale, -0.85, 0.85);
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

  fetch("/models/fsaverage5.json", { signal: abort.signal })
    .then((response) => { if (!response.ok) throw new Error("Cortex model unavailable"); return response.json() as Promise<CortexModel>; })
    .then((model) => {
      if (disposed) return;
      for (const side of ["left", "right"] as const) {
        const source = model[side];
        const prepared = prepareHemisphere(source);
        const mm = deformHemisphere(prepared, parameters);
        const positions = toDisplayPositions(mm, side);
        const geometry = new THREE.BufferGeometry();
        geometry.setIndex(source.faces);
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
        geometry.setAttribute("normal", new THREE.BufferAttribute(surfaceNormals(positions, source.faces), 3).setUsage(THREE.DynamicDrawUsage));
        geometry.setAttribute("sulc", new THREE.Float32BufferAttribute(source.sulc, 1));
        parts.push({ prepared, geometry, mm, side });
        group.add(new THREE.Mesh(geometry, material));
      }
      ready = true;
      resize();
      renderer.compile(scene, camera);
      if (failed) return;
      onReady();
      invalidate();
    })
    .catch(fail);

  return {
    setParameters(next: FoldingParameters) {
      parameters = next;
      uniforms.folding.value = next.folding;
      uniforms.depth.value = next.depth;
      geometryDirty = true;
      invalidate();
    },
    setScan(scan: ScanUpdate | null) {
      uniforms.previousMap.value.dispose();
      uniforms.previousMap.value = uniforms.nextMap.value;
      uniforms.nextMap.value = mapTexture(scan);
      if (!scan) { uniforms.previousMap.value.dispose(); uniforms.previousMap.value = mapTexture(null); }
      const spot = scan ? pointAt(scan.spot * 45) : { x: 0, y: 0 };
      uniforms.origin.value.set(spot.x, spot.y);
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
      parts.forEach(({ geometry }) => geometry.dispose());
      uniforms.previousMap.value.dispose(); uniforms.nextMap.value.dispose(); ramp.dispose();
      const loseContext = context.getExtension("WEBGL_lose_context");
      material.dispose(); renderer.dispose();
      // Strict Mode reuses this canvas for its second setup. Only release the
      // context once React has actually detached it, not during that rehearsal.
      queueMicrotask(() => { if (!canvas.isConnected) loseContext?.loseContext(); });
    },
  };
}
