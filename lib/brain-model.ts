export const CORTEX_URL = "/models/fsaverage6.bin.gz";
export type CortexHemisphere = { positions: Float32Array; faces: Uint32Array; cavity: Float32Array };
export type CortexAsset = Record<"left" | "right", CortexHemisphere>;
/**
 * Real FreeSurfer fsaverage6 cortex, obtained via Nilearn; closed and remeshed
 * offline. Only final uint16 positions/indices and uint8 cavity are shipped.
 * https://nilearn.github.io/stable/modules/description/fsaverage6.html
 * FreeSurfer Software License 1.0 (MGH): /models/FREESURFER-LICENSE.txt.
 */
export function decodeCortex(buffer: ArrayBuffer): CortexAsset {
  const view = new DataView(buffer);
  const magic = buffer.byteLength >= 8 ? new TextDecoder().decode(new Uint8Array(buffer, 0, 8)) : "";
  if (magic !== "LUCIDC01") throw new Error("Invalid cortex model");
  let offset = 8;
  function hemisphere(): CortexHemisphere {
    const count = view.getUint32(offset, true), triangles = view.getUint32(offset + 4, true); offset += 8;
    if (count > 65535 || count < 4 || triangles < 4 || triangles > 200000) throw new Error("Invalid cortex counts");
    const low = [0, 1, 2].map((i) => view.getFloat32(offset + i * 4, true));
    const extent = [0, 1, 2].map((i) => view.getFloat32(offset + 12 + i * 4, true)); offset += 24;
    if (![...low, ...extent].every(Number.isFinite) || extent.some((v) => v <= 0)) throw new Error("Invalid cortex bounds");
    const positions = Float32Array.from({ length: count * 3 }, (_, i) => low[i % 3] + view.getUint16(offset + i * 2, true) / 65535 * extent[i % 3]); offset += count * 6;
    const faces = Uint32Array.from({ length: triangles * 3 }, (_, i) => view.getUint16(offset + i * 2, true)); offset += triangles * 6;
    if (faces.some((index) => index >= count)) throw new Error("Invalid cortex index");
    const cavity = Float32Array.from({ length: count }, (_, i) => view.getUint8(offset + i) / 255); offset += count;
    offset = Math.ceil(offset / 4) * 4;
    return { positions, faces, cavity };
  }
  const left = hemisphere(), right = hemisphere();
  if (offset !== buffer.byteLength) throw new Error("Unexpected cortex payload size");
  return { left, right };
}
