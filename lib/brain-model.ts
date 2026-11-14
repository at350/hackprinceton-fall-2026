import type { CortexModel, Hemisphere } from "./brain-geometry.ts";
export const CORTEX_URL = "/models/fsaverage6.bin.gz";
export type BakedHemisphere = { positions: Float32Array; sulc: Float32Array };
export type CortexAsset = { model: CortexModel; baked: Record<"left" | "right", BakedHemisphere> };
/**
 * Modified FreeSurfer fsaverage6 template, obtained via Nilearn. Quantized source
 * positions/indices and baked default geometry use uint16; cavity uses uint8.
 * Source: https://nilearn.github.io/stable/modules/description/fsaverage6.html
 * FreeSurfer Software License 1.0 (MGH): /models/FREESURFER-LICENSE.txt.
 */
export function decodeCortex(buffer: ArrayBuffer): CortexAsset {
  const view = new DataView(buffer);
  if (buffer.byteLength < 8 || new TextDecoder().decode(new Uint8Array(buffer, 0, 8)) !== "LUCIDB01") throw new Error("Invalid cortex model");
  let offset = 8;
  function bounds() {
    const low = [0, 1, 2].map((i) => view.getFloat32(offset + i * 4, true));
    const extent = [0, 1, 2].map((i) => view.getFloat32(offset + 12 + i * 4, true)); offset += 24;
    if (![...low, ...extent].every(Number.isFinite) || extent.some((v) => v <= 0)) throw new Error("Invalid cortex bounds");
    return { low, extent };
  }
  function positions(count: number, box: ReturnType<typeof bounds>) {
    const out = Array.from({ length: count * 3 }, (_, i) => box.low[i % 3] + view.getUint16(offset + i * 2, true) / 65535 * box.extent[i % 3]); offset += count * 6; return out;
  }
  function field(count: number) {
    const out = Array.from({ length: count }, (_, i) => view.getUint8(offset + i) / 255); offset += count; return out;
  }
  function hemisphere(): { source: Hemisphere; baked: BakedHemisphere } {
    const count = view.getUint32(offset, true), triangles = view.getUint32(offset + 4, true); offset += 8;
    if (count > 65535 || count < 4 || triangles < 4 || triangles > 200000) throw new Error("Invalid cortex counts");
    const box = bounds(), pial = positions(count, box), inflated = positions(count, box);
    const faces = Array.from({ length: triangles * 3 }, (_, i) => view.getUint16(offset + i * 2, true)); offset += triangles * 6;
    if (faces.some((index) => index >= count)) throw new Error("Invalid cortex index");
    const sulc = field(count); offset = Math.ceil(offset / 4) * 4;
    const bakedPositions = Float32Array.from(positions(count, bounds()));
    const cavity = Float32Array.from(field(count)); offset = Math.ceil(offset / 4) * 4;
    return { source: { vertices: pial, inflated, blob: inflated, faces, sulc }, baked: { positions: bakedPositions, sulc: cavity } };
  }
  const left = hemisphere(), right = hemisphere();
  if (offset !== buffer.byteLength) throw new Error("Unexpected cortex payload size");
  return { model: { left: left.source, right: right.source }, baked: { left: left.baked, right: right.baked } };
}
