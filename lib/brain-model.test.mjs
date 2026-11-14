import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";

import { decodeCortex, CORTEX_URL } from "../lib/brain-model.ts";
import { prepareAnatomy, generateAnatomicalFolds, deformAnatomy, foldAttributes, DEFAULT_SEED } from "../lib/brain-anatomy.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- A tiny, hand-built LUCIDB01 buffer, used only to exercise the decoder's
// format rules in isolation. Mirrors decodeCortex's own byte layout exactly
// (magic, then per-hemisphere: header, bounds, pial, inflated, faces, sulc,
// pad-to-4, baked bounds, baked positions, cavity, pad-to-4) so every offset
// below can be independently corrupted for the rejection tests.

class ByteWriter {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  push(bytes) {
    this.chunks.push(bytes);
    this.length += bytes.length;
    return this.length - bytes.length; // offset this chunk starts at
  }
  uint32(value) {
    const buffer = new ArrayBuffer(4);
    new DataView(buffer).setUint32(0, value, true);
    return this.push(new Uint8Array(buffer));
  }
  float32Triplet(values) {
    const buffer = new ArrayBuffer(12);
    const view = new DataView(buffer);
    for (let i = 0; i < 3; i++) view.setFloat32(i * 4, values[i], true);
    return this.push(new Uint8Array(buffer));
  }
  uint16Array(values) {
    const buffer = new ArrayBuffer(values.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < values.length; i++) view.setUint16(i * 2, values[i], true);
    return this.push(new Uint8Array(buffer));
  }
  uint8Array(values) {
    return this.push(Uint8Array.from(values));
  }
  alignTo4() {
    const padding = (4 - (this.length % 4)) % 4;
    if (padding > 0) this.push(new Uint8Array(padding));
  }
  toArrayBuffer() {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out.buffer;
  }
}

function quantizeUint16(value, low, extent) {
  return Math.max(0, Math.min(65535, Math.round((value - low) / extent * 65535)));
}

function writeBounds(writer, low, extent) {
  const offset = writer.length;
  writer.float32Triplet(low);
  writer.float32Triplet(extent);
  return offset;
}

function writePositions(writer, points, low, extent) {
  const quantized = [];
  for (const [x, y, z] of points) {
    quantized.push(quantizeUint16(x, low[0], extent[0]), quantizeUint16(y, low[1], extent[1]), quantizeUint16(z, low[2], extent[2]));
  }
  return writer.uint16Array(quantized);
}

function writeHemisphere(writer, h) {
  const offsets = {};
  offsets.countOffset = writer.length;
  writer.uint32(h.points.length);
  offsets.trianglesOffset = writer.length;
  writer.uint32(h.faces.length / 3);
  offsets.boundsOffset = writeBounds(writer, h.low, h.extent);
  writePositions(writer, h.points, h.low, h.extent); // pial
  writePositions(writer, h.inflated ?? h.points, h.low, h.extent); // inflated
  offsets.facesOffset = writer.uint16Array(h.faces);
  offsets.sulcOffset = writer.uint8Array(h.sulc.map((v) => Math.round(v * 255)));
  writer.alignTo4();
  offsets.bakedBoundsOffset = writeBounds(writer, h.low, h.extent);
  writePositions(writer, h.bakedPoints ?? h.points, h.low, h.extent);
  offsets.cavityOffset = writer.uint8Array(h.cavity.map((v) => Math.round(v * 255)));
  writer.alignTo4();
  return offsets;
}

// A tetrahedron: 4 vertices, 4 triangular faces, all indices in range.
function tinyHemisphere() {
  return {
    points: [[0, 0, 0], [5, 0, 0], [0, 5, 0], [0, 0, 5]],
    inflated: [[0, 0, 0], [6, 0, 0], [0, 6, 0], [0, 0, 6]],
    bakedPoints: [[0, 0, 0], [4, 0, 0], [0, 4, 0], [0, 0, 4]],
    faces: [0, 1, 2, 0, 1, 3, 1, 2, 3, 2, 0, 3],
    sulc: [0.1, 0.9, 0.3, 0.6],
    cavity: [0, 0.5, 1, 0.25],
    low: [-10, -10, -10],
    extent: [20, 20, 20],
  };
}

function buildValidBuffer() {
  const writer = new ByteWriter();
  const magicOffset = writer.push(new TextEncoder().encode("LUCIDB01"));
  const left = writeHemisphere(writer, tinyHemisphere());
  const right = writeHemisphere(writer, tinyHemisphere());
  return { buffer: writer.toArrayBuffer(), magicOffset, left, right };
}

function patchUint32(buffer, offset, value) {
  new DataView(buffer).setUint32(offset, value, true);
}
function patchFloat32(buffer, offset, value) {
  new DataView(buffer).setFloat32(offset, value, true);
}
function patchUint16(buffer, offset, value) {
  new DataView(buffer).setUint16(offset, value, true);
}

describe("decodeCortex: well-formed buffer", () => {
  test("decodes matching shapes for both hemispheres", () => {
    const { buffer } = buildValidBuffer();
    const asset = decodeCortex(buffer);
    for (const side of ["left", "right"]) {
      const h = asset.model[side];
      assert.equal(h.vertices.length, 12); // 4 vertices * 3
      assert.equal(h.inflated.length, 12);
      assert.equal(h.blob, h.inflated, "blob is the inflated surface, not a separate decoded field");
      assert.equal(h.faces.length, 12); // 4 triangles * 3
      assert.equal(h.sulc.length, 4);
      const baked = asset.baked[side];
      assert.equal(baked.positions.length, 12);
      assert.equal(baked.sulc.length, 4);
    }
  });

  test("decoded positions are finite and roughly recover the original (quantized) values", () => {
    const { buffer } = buildValidBuffer();
    const asset = decodeCortex(buffer);
    const h = asset.model.left;
    for (const v of h.vertices) assert.ok(Number.isFinite(v));
    for (const v of h.inflated) assert.ok(Number.isFinite(v));
    // v1 = [5, 0, 0] against bounds low=-10, extent=20: quantization step is tiny.
    assert.ok(Math.abs(h.vertices[3] - 5) < 0.01);
    assert.ok(Math.abs(h.vertices[4] - 0) < 0.01);
  });

  test("face indices are all valid vertex references", () => {
    const { buffer } = buildValidBuffer();
    const asset = decodeCortex(buffer);
    for (const side of ["left", "right"]) {
      const h = asset.model[side];
      const vertexCount = h.vertices.length / 3;
      for (const index of h.faces) assert.ok(index >= 0 && index < vertexCount);
    }
  });

  test("sulc and baked cavity fields decode within [0, 1]", () => {
    const { buffer } = buildValidBuffer();
    const asset = decodeCortex(buffer);
    for (const side of ["left", "right"]) {
      for (const v of asset.model[side].sulc) assert.ok(v >= 0 && v <= 1);
      for (const v of asset.baked[side].sulc) assert.ok(v >= 0 && v <= 1);
    }
  });
});

describe("decodeCortex: rejects malformed input", () => {
  test("rejects a buffer with the wrong magic", () => {
    const { buffer, magicOffset } = buildValidBuffer();
    new Uint8Array(buffer, magicOffset, 8).set(new TextEncoder().encode("LUCIDB02"));
    assert.throws(() => decodeCortex(buffer), /Invalid cortex model/);
  });

  test("rejects a buffer shorter than the magic itself", () => {
    assert.throws(() => decodeCortex(new ArrayBuffer(4)), /Invalid cortex model/);
  });

  test("rejects truncation at any point past the header", () => {
    const { buffer } = buildValidBuffer();
    // Cut the buffer at a handful of points inside the structure; every one
    // should fail closed (either an explicit validation error or a DataView
    // out-of-bounds read), never silently decode something wrong.
    for (const cutAt of [10, 20, 40, 80, buffer.byteLength - 1]) {
      assert.throws(() => decodeCortex(buffer.slice(0, cutAt)), `expected a throw when truncated at byte ${cutAt}`);
    }
  });

  test("rejects a buffer with extra trailing bytes", () => {
    const { buffer } = buildValidBuffer();
    const withTrailer = new Uint8Array(buffer.byteLength + 4);
    withTrailer.set(new Uint8Array(buffer));
    const trailer = withTrailer.buffer;
    assert.throws(() => decodeCortex(trailer), /Unexpected cortex payload size/);
  });

  test("rejects a vertex count that is too low, too high, or zero", () => {
    for (const count of [0, 3, 65536]) {
      const { buffer, left } = buildValidBuffer();
      patchUint32(buffer, left.countOffset, count);
      assert.throws(() => decodeCortex(buffer), /Invalid cortex counts/, `count=${count}`);
    }
  });

  test("rejects a triangle count that is too low or too high", () => {
    for (const triangles of [0, 3, 200001]) {
      const { buffer, left } = buildValidBuffer();
      patchUint32(buffer, left.trianglesOffset, triangles);
      assert.throws(() => decodeCortex(buffer), /Invalid cortex counts/, `triangles=${triangles}`);
    }
  });

  test("rejects non-finite or non-positive bounds", () => {
    const lowOffsetWithinBlock = 0, extentOffsetWithinBlock = 12;
    for (const [fieldOffset, value] of [
      [lowOffsetWithinBlock, NaN],
      [lowOffsetWithinBlock, Infinity],
      [extentOffsetWithinBlock, 0],
      [extentOffsetWithinBlock, -5],
      [extentOffsetWithinBlock, NaN],
    ]) {
      const { buffer, left } = buildValidBuffer();
      patchFloat32(buffer, left.boundsOffset + fieldOffset, value);
      assert.throws(() => decodeCortex(buffer), /Invalid cortex bounds/, `offset=${fieldOffset} value=${value}`);
    }
  });

  test("rejects non-finite or non-positive baked bounds", () => {
    const { buffer, left } = buildValidBuffer();
    patchFloat32(buffer, left.bakedBoundsOffset + 12, 0); // baked extent.x = 0
    assert.throws(() => decodeCortex(buffer), /Invalid cortex bounds/);
  });

  test("rejects a face index that is out of range", () => {
    const { buffer, left } = buildValidBuffer();
    // The fixture has 4 vertices (valid indices 0-3); point the first face's
    // first index at vertex 4, which does not exist.
    patchUint16(buffer, left.facesOffset, 4);
    assert.throws(() => decodeCortex(buffer), /Invalid cortex index/);
  });
});

describe("decodeCortex: real fsaverage6 asset", () => {
  // Checked-in required asset: a missing or malformed file should fail the
  // suite outright, not be silently skipped. Shipped gzipped; Next serves it
  // with Content-Encoding: gzip so the browser's fetch auto-decodes it, but
  // here we gunzip explicitly before handing LUCIDB01 bytes to the decoder.
  const assetPath = path.join(__dirname, "..", "public", "models", "fsaverage6.bin.gz");
  const bytes = gunzipSync(readFileSync(assetPath));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const asset = decodeCortex(buffer);

  test(`${CORTEX_URL} decodes into two internally consistent hemispheres`, () => {
    for (const side of ["left", "right"]) {
      const h = asset.model[side];
      const vertexCount = h.vertices.length / 3;
      assert.equal(h.vertices.length % 3, 0);
      assert.equal(h.inflated.length, h.vertices.length);
      assert.equal(h.blob, h.inflated);
      assert.equal(h.faces.length % 3, 0);
      assert.equal(h.sulc.length, vertexCount);
      for (const index of h.faces) assert.ok(index >= 0 && index < vertexCount);

      const baked = asset.baked[side];
      assert.equal(baked.positions.length, h.vertices.length);
      assert.equal(baked.sulc.length, vertexCount);
    }
  });

  test("all decoded positions are finite, and sulc/cavity stay within [0, 1]", () => {
    for (const side of ["left", "right"]) {
      const h = asset.model[side];
      for (const v of h.vertices) assert.ok(Number.isFinite(v));
      for (const v of h.inflated) assert.ok(Number.isFinite(v));
      for (const v of h.sulc) assert.ok(v >= 0 && v <= 1);
      const baked = asset.baked[side];
      for (const v of baked.positions) assert.ok(Number.isFinite(v));
      for (const v of baked.sulc) assert.ok(v >= 0 && v <= 1);
    }
  });

  // The baked default geometry/cavity shipped in the asset is a frozen,
  // quantized snapshot of the runtime pipeline at DEFAULT_SEED / count=0.5 /
  // depth=1 (the right hemisphere uses the same seed convention as
  // lib/brain-cortex.worker.ts: seed ^ 0x9e3779b9). This checks the two
  // stay in agreement without asserting any hardcoded geometry — if the
  // bake is regenerated against evolving math, this test moves with it.
  test("baked defaults match the runtime pipeline within quantization tolerance", () => {
    for (const side of ["left", "right"]) {
      const seed = side === "left" ? DEFAULT_SEED : (DEFAULT_SEED ^ 0x9e3779b9) >>> 0;
      const prepared = prepareAnatomy(asset.model[side], side, 0);
      const delta = generateAnatomicalFolds(prepared, seed, 0.5);
      const deformed = deformAnatomy(prepared, delta, 1);
      const attributes = foldAttributes(prepared, delta, 0.5);

      const bakedPositions = asset.baked[side].positions;
      const bakedCavity = asset.baked[side].sulc;

      let maxPositionDiff = 0;
      for (let i = 0; i < deformed.length; i++) maxPositionDiff = Math.max(maxPositionDiff, Math.abs(deformed[i] - bakedPositions[i]));
      assert.ok(maxPositionDiff < 4e-5, `${side}: baked positions drifted from the runtime pipeline by ${maxPositionDiff}`);

      let maxCavityDiff = 0;
      for (let i = 0; i < attributes.sulc.length; i++) maxCavityDiff = Math.max(maxCavityDiff, Math.abs(attributes.sulc[i] - bakedCavity[i]));
      assert.ok(maxCavityDiff < 1 / 255 + 1e-6, `${side}: baked cavity drifted from the runtime pipeline by ${maxCavityDiff}`);
    }
  });
});
