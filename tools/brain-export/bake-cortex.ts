/** Offline Node 26 baker: closed-cortex.json → final render-only binary. */
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { surfaceNormals, toDisplayPositions } from "../../lib/brain-geometry.ts";
import { surfaceCavity } from "./cavity.ts";
const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath || sourcePath === outputPath) throw new Error("Provide distinct source and output paths");
const source = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<"left" | "right", { vertices: number[]; faces: number[] }>;
const chunks: Buffer[] = [Buffer.from("LUCIDC01")];
for (const side of ["left", "right"] as const) {
  const p = toDisplayPositions(source[side].vertices, side), faces = Uint32Array.from(source[side].faces), count = p.length / 3;
  if (count < 4 || count > 65535 || p.length % 3 || faces.length % 3 || !p.every(Number.isFinite) || faces.some((index) => index >= count)) throw new Error("Invalid closed cortex geometry");
  const normals = surfaceNormals(p, faces);
  let cavity = surfaceCavity(p, normals, faces);
  const adjacent = Array.from({ length: count }, () => new Set<number>());
  for (let i = 0; i < faces.length; i += 3) {
    const a = faces[i], b = faces[i + 1], c = faces[i + 2];
    adjacent[a].add(b).add(c); adjacent[b].add(a).add(c); adjacent[c].add(a).add(b);
  }
  for (let pass = 0; pass < 3; pass++) cavity = Float32Array.from(cavity, (v, i) => (v * 2 + [...adjacent[i]].reduce((sum, j) => sum + cavity[j], 0) / Math.max(1, adjacent[i].size)) / 3);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) { lo[i % 3] = Math.min(lo[i % 3], p[i]); hi[i % 3] = Math.max(hi[i % 3], p[i]); }
  const size = 32 + count * 7 + faces.length * 2, out = Buffer.alloc(Math.ceil(size / 4) * 4);
  out.writeUInt32LE(count, 0); out.writeUInt32LE(faces.length / 3, 4);
  for (let axis = 0; axis < 3; axis++) { out.writeFloatLE(lo[axis], 8 + axis * 4); out.writeFloatLE(hi[axis] - lo[axis], 20 + axis * 4); }
  for (let i = 0; i < p.length; i++) out.writeUInt16LE(Math.round((p[i] - lo[i % 3]) / (hi[i % 3] - lo[i % 3]) * 65535), 32 + i * 2);
  let offset = 32 + p.length * 2;
  for (let i = 0; i < faces.length; i++) out.writeUInt16LE(faces[i], offset + i * 2);
  offset += faces.length * 2;
  for (let i = 0; i < count; i++) out[offset + i] = Math.round(Math.max(0, Math.min(1, cavity[i])) * 255);
  chunks.push(out);
}
const result = Buffer.concat(chunks), gzip = gzipSync(result, { level: 9 });
writeFileSync(outputPath, gzip);
console.log(JSON.stringify({ bytes: result.length, gzip: gzip.length, brotli: brotliCompressSync(result).length }));
