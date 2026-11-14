import * as THREE from "three";
import { heatRGB } from "@/components/ui";
import { decodeCortex, CORTEX_URL } from "./brain-model";
import { mapTextureData, mapVertexAttributes, scalpSpot3D } from "./brain-heat";
import type { ScanUpdate } from "./types";
import { scanRevealRadius, surfaceNormals } from "./brain-geometry";

const VIEW = 1.25;
const vertexShader = `
  attribute float sulc;
  attribute vec2 mapUV;
  attribute vec3 head;
  varying vec2 vMapUV;
  varying vec3 vHead;
  varying vec3 vNormal;
  varying vec3 vPosition;
  varying float vSulc;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vPosition = position;
    vSulc = sulc; vMapUV = mapUV; vHead = head;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const fragmentShader = `
  uniform sampler2D heatRamp;
  uniform sampler2D beforeMap;
  uniform sampler2D afterMap;
  uniform float beforeSize;
  uniform float afterSize;
  uniform vec3 origin;
  uniform float radius;
  varying vec3 vNormal;
  varying vec3 vPosition;
  varying float vSulc;
  varying vec2 vMapUV;
  varying vec3 vHead;
  vec2 sampleMap(sampler2D field, float size) {
    if (any(lessThan(vMapUV, vec2(0.0))) || any(greaterThan(vMapUV, vec2(1.0)))) return vec2(0.0);
    // Align the map's sample coordinates with texel centres, as on the 2D grid.
    return texture2D(field, (vMapUV * (size - 1.0) + 0.5) / size).rg;
  }
  vec3 tissue(vec2 sampleValue, vec3 cortex) {
    float value = sampleValue.r;
    float coverage = sampleValue.g;
    float alpha = smoothstep(0.2, 0.65, value) * 0.94;
    vec3 heat = texture2D(heatRamp, vec2(clamp((value - 0.15) / 0.75, 0.0, 1.0), 0.5)).rgb;
    // Treat likelihood as a surface tint under the same illumination and cavity.
    return mix(cortex * mix(0.20, 1.0, coverage), heat * (cortex / vec3(0.58, 0.64, 0.68)), alpha);
  }
  void main() {
    vec3 n = normalize(vNormal);
    vec3 key = normalize(vec3(-0.6, 0.7, 1.1));
    vec3 rim = normalize(vec3(0.8, -0.4, 0.5));
    float light = 0.36 + 0.66 * max(dot(n, key), 0.0) + 0.06 * max(dot(n, rim), 0.0);
    float groove = smoothstep(0.04, 0.72, vSulc);
    float ao = 1.0 - pow(groove, 1.15) * 0.88;
    float crown = 1.0 + 0.09 * (1.0 - vSulc) * max(dot(n, key), 0.0);
    float sheen = 0.045 * pow(max(dot(n, normalize(key + vec3(0.0, 0.0, 1.0))), 0.0), 6.0);
    float midline = 0.014 * sin(vPosition.y * 7.0 + 0.4) + 0.003 * sin(vPosition.y * 19.0);
    float medial = (1.0 - smoothstep(0.006, 0.035, abs(vPosition.x - midline)));
    float flank = mix(0.45, 1.0, smoothstep(-0.15, 0.75, n.z));
    vec3 cortex = (vec3(0.58, 0.64, 0.68) * light * crown + vec3(sheen)) * ao * flank * (1.0 - medial * 0.9);
    float reveal = 1.0 - smoothstep(radius - 1.2, radius + 1.2, distance(vHead, origin));
    gl_FragColor = vec4(mix(tissue(sampleMap(beforeMap, beforeSize), cortex), tissue(sampleMap(afterMap, afterSize), cortex), reveal), 1.0);
  }
`;

/** An imperative, render-on-demand scene; React owns the canvas and scan overlay. */
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
  function textureFor(map: number[][] | null) {
    const packed = mapTextureData(map);
    const texture = new THREE.DataTexture(packed.data, packed.size, packed.size);
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return { texture, size: packed.size };
  }
  const initialBefore = textureFor(null), initialAfter = textureFor(null);
  const uniforms = {
    heatRamp: { value: ramp }, beforeMap: { value: initialBefore.texture }, afterMap: { value: initialAfter.texture },
    beforeSize: { value: initialBefore.size }, afterSize: { value: initialAfter.size }, origin: { value: new THREE.Vector3() }, radius: { value: 300 },
  };
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, side: THREE.FrontSide });
  const parts = new Map<string, THREE.BufferGeometry>();
  let disposed = false, ready = false, failed = false, raf = 0;
  let currentMap: number[][] | null = null, mapUpdates = 0;
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

  fetch(CORTEX_URL, { signal: abort.signal })
    .then((response) => { if (!response.ok) throw new Error("Cortex model unavailable"); return response.arrayBuffer(); })
    .then((buffer) => {
      if (disposed) return;
      const asset = decodeCortex(buffer);
      for (const side of ["left", "right"] as const) {
        const { positions, faces, cavity } = asset[side];
        const geometry = new THREE.BufferGeometry();
        geometry.setIndex(new THREE.BufferAttribute(faces, 1));
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute("normal", new THREE.BufferAttribute(surfaceNormals(positions, faces), 3));
        geometry.setAttribute("sulc", new THREE.BufferAttribute(cavity, 1));
        const projected = mapVertexAttributes(positions);
        geometry.setAttribute("mapUV", new THREE.BufferAttribute(projected.uv, 2));
        geometry.setAttribute("head", new THREE.BufferAttribute(projected.head, 3));
        geometry.computeBoundingSphere();
        parts.set(side, geometry);
        group.add(new THREE.Mesh(geometry, material));
      }
      ready = true; resize(); renderer.compile(scene, camera); renderer.render(scene, camera);
      if (failed) return;
      canvas.dataset.firstFrameMs = performance.now().toFixed(1);
      onReady(); invalidate();
    })
    .catch(() => { if (!disposed) fail(); });

  return {
    setScan(scan: ScanUpdate | null) {
      const nextMap = scan?.map ?? null;
      if (nextMap === currentMap) return;
      // Map changes include live previews and clear/rejected results even when
      // the finished spot list is unchanged. Never substitute scripted heat.
      const next = textureFor(nextMap);
      uniforms.beforeMap.value.dispose();
      uniforms.beforeMap.value = uniforms.afterMap.value;
      uniforms.beforeSize.value = uniforms.afterSize.value;
      uniforms.afterMap.value = next.texture;
      uniforms.afterSize.value = next.size;
      currentMap = nextMap;
      canvas.dataset.mapUpdates = String(++mapUpdates);
      canvas.dataset.heatSource = "axial-map";
      uniforms.origin.value.fromArray(scalpSpot3D(scan?.spot ?? 0));
      scanStart = scan ? performance.now() : -Infinity;
      invalidate();
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
      parts.forEach((geometry) => geometry.dispose());
      ramp.dispose(); uniforms.beforeMap.value.dispose(); uniforms.afterMap.value.dispose();
      const loseContext = context.getExtension("WEBGL_lose_context");
      material.dispose(); renderer.dispose();
      // Strict Mode reuses this canvas for its second setup. Only release the
      // context once React has actually detached it, not during that rehearsal.
      queueMicrotask(() => { if (!canvas.isConnected) loseContext?.loseContext(); });
    },
  };
}
