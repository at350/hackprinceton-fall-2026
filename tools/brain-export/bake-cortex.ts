/** Run with Node 26: node tools/brain-export/bake-cortex.ts <unbaked fs6.bin> <output.bin>. */
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { prepareAnatomy, generateAnatomicalFolds, deformAnatomy, foldAttributes, DEFAULT_SEED } from "../../lib/brain-anatomy.ts";
import type { Hemisphere } from "../../lib/brain-geometry.ts";
const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath || sourcePath === outputPath) throw new Error("Provide distinct source and output paths");
const input = readFileSync(sourcePath), view = new DataView(input.buffer, input.byteOffset, input.byteLength);
if (input.subarray(0, 8).toString() !== "LUCIDFS6") throw new Error("Expected unbaked source asset");
let offset = 8;
const chunks: Buffer[] = [Buffer.from("LUCIDB01")];
for (const side of ["left", "right"] as const) {
  const start = offset, count = view.getUint32(offset, true), triangles = view.getUint32(offset + 4, true); offset += 8;
  const low = [0, 1, 2].map((i) => view.getFloat32(offset + i * 4, true));
  const extent = [0, 1, 2].map((i) => view.getFloat32(offset + 12 + i * 4, true)); offset += 24;
  function positions() {
    const points = Array.from({ length: count * 3 }, (_, i) => low[i % 3] + view.getUint16(offset + i * 2, true) / 65535 * extent[i % 3]); offset += count * 6; return points;
  }
  const vertices = positions(), inflated = positions();
  const faces = Array.from({ length: triangles * 3 }, (_, i) => view.getUint16(offset + i * 2, true)); offset += triangles * 6;
  const sulc = Array.from({ length: count }, (_, i) => view.getUint8(offset + i) / 255); offset += count; offset = Math.ceil(offset / 4) * 4;
  const source: Hemisphere = { vertices, inflated, blob: inflated, faces, sulc };
  const a = prepareAnatomy(source, side, 0), delta = generateAnatomicalFolds(a, side === "left" ? DEFAULT_SEED : DEFAULT_SEED ^ 0x9e3779b9, 0.5);
  const p = deformAnatomy(a, delta, 1), attributes = foldAttributes(a, delta, 0.5);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) { lo[i % 3] = Math.min(lo[i % 3], p[i]); hi[i % 3] = Math.max(hi[i % 3], p[i]); }
  const size = 24 + count * 7, baked = Buffer.alloc(Math.ceil(size / 4) * 4);
  for (let axis = 0; axis < 3; axis++) { baked.writeFloatLE(lo[axis], axis * 4); baked.writeFloatLE(hi[axis] - lo[axis], 12 + axis * 4); }
  for (let i = 0; i < p.length; i++) baked.writeUInt16LE(Math.round((p[i] - lo[i % 3]) / (hi[i % 3] - lo[i % 3]) * 65535), 24 + i * 2);
  for (let i = 0; i < count; i++) baked[24 + count * 6 + i] = Math.round(Math.max(0, Math.min(1, attributes.sulc[i])) * 255);
  chunks.push(input.subarray(start, offset), baked);
}
const result = Buffer.concat(chunks); writeFileSync(outputPath, gzipSync(result, { level: 9 }));
console.log(JSON.stringify({ bytes: result.length, gzip: gzipSync(result).length, brotli: brotliCompressSync(result).length }));
