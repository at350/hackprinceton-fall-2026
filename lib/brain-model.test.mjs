import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";

import { decodeCortex, CORTEX_URL } from "../lib/brain-model.ts";
import { surfaceNormals } from "../lib/brain-geometry.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- A tiny, hand-built LUCIDC01 buffer, used only to exercise the decoder's
// format rules in isolation. Mirrors decodeCortex's own byte layout exactly
// (magic, then per-hemisphere: count+triangles, low/extent bounds, final
// display positions, faces, cavity, pad-to-4) so every offset below can be
// independently corrupted for the rejection tests.

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
  offsets.positionsOffset = writePositions(writer, h.points, h.low, h.extent);
  offsets.facesOffset = writer.uint16Array(h.faces);
  offsets.cavityOffset = writer.uint8Array(h.cavity.map((v) => Math.round(v * 255)));
  writer.alignTo4();
  return offsets;
}

// A tetrahedron: 4 vertices, 4 triangular faces, all indices in range, and
// (incidentally) itself a closed/watertight surface — every one of its 6
// edges is shared by exactly 2 faces.
function tinyHemisphere() {
  return {
    points: [[0, 0, 0], [5, 0, 0], [0, 5, 0], [0, 0, 5]],
    faces: [0, 1, 2, 0, 1, 3, 1, 2, 3, 2, 0, 3],
    cavity: [0, 0.5, 1, 0.25],
    low: [-10, -10, -10],
    extent: [20, 20, 20],
  };
}

function buildValidBuffer() {
  const writer = new ByteWriter();
  const magicOffset = writer.push(new TextEncoder().encode("LUCIDC01"));
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

// True iff every undirected edge of the mesh is used by exactly 2 triangles
// (a closed/watertight 2-manifold surface has no boundary).
function isEdgeWatertight(faces) {
  const edgeCounts = new Map();
  for (let i = 0; i < faces.length; i += 3) {
    const triangle = [faces[i], faces[i + 1], faces[i + 2]];
    for (let e = 0; e < 3; e++) {
      const a = triangle[e], b = triangle[(e + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }
  for (const count of edgeCounts.values()) if (count !== 2) return false;
  return true;
}

describe("isEdgeWatertight (test helper sanity)", () => {
  test("a tetrahedron is closed: every edge is shared by exactly 2 faces", () => {
    assert.equal(isEdgeWatertight(tinyHemisphere().faces), true);
  });

  test("a single triangle is open: every edge is used only once", () => {
    assert.equal(isEdgeWatertight([0, 1, 2]), false);
  });

  test("a tetrahedron missing one face is open at its boundary", () => {
    const openFaces = tinyHemisphere().faces.slice(0, 9); // drop the last triangle
    assert.equal(isEdgeWatertight(openFaces), false);
  });
});

describe("decodeCortex: well-formed buffer", () => {
  test("decodes matching shapes for both hemispheres", () => {
    const { buffer } = buildValidBuffer();
    const asset = decodeCortex(buffer);
    for (const side of ["left", "right"]) {
      const h = asset[side];
      assert.equal(h.positions.length, 12); // 4 vertices * 3
      assert.equal(h.faces.length, 12); // 4 triangles * 3
      assert.equal(h.cavity.length, 4);
    }
  });

  test("decoded positions are finite and roughly recover the original (quantized) values", () => {
    const { buffer } = buildValidBuffer();
    const asset = decodeCortex(buffer);
    for (const v of asset.left.positions) assert.ok(Number.isFinite(v));
    // v1 = [5, 0, 0] against bounds low=-10, extent=20: quantization step is tiny.
    assert.ok(Math.abs(asset.left.positions[3] - 5) < 0.01);
    assert.ok(Math.abs(asset.left.positions[4] - 0) < 0.01);
  });

  test("face indices are all valid vertex references", () => {
    const { buffer } = buildValidBuffer();
    const asset = decodeCortex(buffer);
    for (const side of ["left", "right"]) {
      const h = asset[side];
      const vertexCount = h.positions.length / 3;
      for (const index of h.faces) assert.ok(index >= 0 && index < vertexCount);
    }
  });

  test("cavity decodes within [0, 1]", () => {
    const { buffer } = buildValidBuffer();
    const asset = decodeCortex(buffer);
    for (const side of ["left", "right"]) {
      for (const v of asset[side].cavity) assert.ok(v >= 0 && v <= 1);
    }
  });
});

describe("decodeCortex: rejects malformed input", () => {
  test("rejects a buffer with the wrong magic", () => {
    const { buffer, magicOffset } = buildValidBuffer();
    new Uint8Array(buffer, magicOffset, 8).set(new TextEncoder().encode("LUCIDC02"));
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
    for (const cutAt of [10, 20, 40, buffer.byteLength - 1]) {
      assert.throws(() => decodeCortex(buffer.slice(0, cutAt)), `expected a throw when truncated at byte ${cutAt}`);
    }
  });

  test("rejects a buffer with extra trailing bytes", () => {
    const { buffer } = buildValidBuffer();
    const withTrailer = new Uint8Array(buffer.byteLength + 4);
    withTrailer.set(new Uint8Array(buffer));
    assert.throws(() => decodeCortex(withTrailer.buffer), /Unexpected cortex payload size/);
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
  // here we gunzip explicitly before handing LUCIDC01 bytes to the decoder.
  const assetPath = path.join(__dirname, "..", "public", "models", "fsaverage6.bin.gz");
  const bytes = gunzipSync(readFileSync(assetPath));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const asset = decodeCortex(buffer);

  test(`${CORTEX_URL} decodes into two internally consistent hemispheres`, () => {
    for (const side of ["left", "right"]) {
      const h = asset[side];
      const vertexCount = h.positions.length / 3;
      assert.equal(h.positions.length % 3, 0);
      assert.equal(h.faces.length % 3, 0);
      assert.equal(h.cavity.length, vertexCount);
      for (const index of h.faces) assert.ok(index >= 0 && index < vertexCount);
    }
  });

  test("all decoded positions are finite, and cavity stays within [0, 1]", () => {
    for (const side of ["left", "right"]) {
      const h = asset[side];
      for (const v of h.positions) assert.ok(Number.isFinite(v));
      for (const v of h.cavity) assert.ok(v >= 0 && v <= 1);
    }
  });

  test("each hemisphere mesh is closed: every undirected edge is shared by exactly 2 faces", () => {
    for (const side of ["left", "right"]) {
      assert.ok(isEdgeWatertight(asset[side].faces), `${side} hemisphere has a boundary edge`);
    }
  });

  test("surface normals are finite and unit length everywhere", () => {
    for (const side of ["left", "right"]) {
      const h = asset[side];
      const normals = surfaceNormals(h.positions, h.faces);
      for (let i = 0; i < normals.length; i += 3) {
        const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
        assert.ok(Number.isFinite(length));
        assert.ok(length === 0 || Math.abs(length - 1) < 1e-4, `${side}: non-unit normal length ${length}`);
      }
    }
  });
});
