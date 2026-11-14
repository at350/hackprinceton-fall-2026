import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  clampParameter,
  surfaceNormals,
  prepareHemisphere,
  deformHemisphere,
  toDisplayPositions,
  scanRevealRadius,
  DEFAULT_FOLDING,
  FOLDING_LIMITS,
} from "../lib/brain-geometry.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeHemisphere({ vertexCount = 4, sulc, inflatedOffset = 10 } = {}) {
  // A tiny collinear fixture: blob at origin-ish, inflated pushed out along +z,
  // pial (vertices) pushed further still, so the geometric picture is unambiguous.
  const blob = [];
  const inflated = [];
  const vertices = [];
  for (let i = 0; i < vertexCount; i++) {
    const x = i;
    const y = i * 2;
    const z = 0;
    blob.push(x, y, z);
    inflated.push(x, y, z + inflatedOffset);
    vertices.push(x, y, z + inflatedOffset * 2);
  }
  const faces = [0, 1, 2, 1, 2, 3].slice(0, Math.max(0, (vertexCount - 2) * 3));
  return {
    vertices,
    faces,
    sulc: sulc ?? new Array(vertexCount).fill(0.5),
    inflated,
    blob,
  };
}

describe("clampParameter", () => {
  test("passes through finite values inside range", () => {
    assert.equal(clampParameter(0.5, 0, 1, 0.2), 0.5);
  });

  test("clamps above max and below min", () => {
    assert.equal(clampParameter(5, 0, 1, 0.2), 1);
    assert.equal(clampParameter(-5, 0, 1, 0.2), 0);
  });

  test("falls back to the provided default for non-finite input", () => {
    assert.equal(clampParameter(NaN, 0, 1, 0.3), 0.3);
    assert.equal(clampParameter(Infinity, 0, 2, 0.7), 0.7);
    assert.equal(clampParameter(-Infinity, 0, 2, 0.7), 0.7);
  });
});

describe("surfaceNormals", () => {
  test("a single triangle in the XY plane produces a unit +Z normal at every vertex", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const faces = [0, 1, 2];
    const normals = surfaceNormals(positions, faces);
    for (let i = 0; i < 3; i++) {
      const base = i * 3;
      assert.ok(Math.abs(normals[base] - 0) < 1e-6);
      assert.ok(Math.abs(normals[base + 1] - 0) < 1e-6);
      assert.ok(Math.abs(normals[base + 2] - 1) < 1e-6);
    }
  });

  test("winding order flips the normal direction", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const forward = surfaceNormals(positions, [0, 1, 2]);
    const reversed = surfaceNormals(positions, [0, 2, 1]);
    assert.ok(Math.abs(forward[2] - 1) < 1e-6);
    assert.ok(Math.abs(reversed[2] + 1) < 1e-6);
  });

  test("every output normal is unit length", () => {
    const positions = new Float32Array([
      0, 0, 0, 2, 0, 0, 2, 3, 0, 0, 0, 5,
    ]);
    const faces = [0, 1, 2, 0, 2, 3, 0, 3, 1];
    const normals = surfaceNormals(positions, faces);
    for (let i = 0; i < normals.length; i += 3) {
      const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
      assert.ok(Math.abs(len - 1) < 1e-5, `normal at ${i} has length ${len}`);
    }
  });

  test("a degenerate triangle (zero area) does not produce NaN or Infinity", () => {
    // All three vertices coincide: cross product is the zero vector.
    const positions = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]);
    const normals = surfaceNormals(positions, [0, 1, 2]);
    for (const value of normals) {
      assert.ok(Number.isFinite(value), `expected finite, got ${value}`);
    }
    // The zero-length fallback (`|| 1`) means the result is exactly zero, not NaN.
    assert.deepEqual(Array.from(normals), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test("a degenerate (collinear) triangle mixed with a real one still yields finite normals everywhere", () => {
    const positions = new Float32Array([
      0, 0, 0, 1, 0, 0, 2, 0, 0, // collinear triangle, zero area
      0, 0, 0, 1, 0, 0, 0, 1, 0, // real triangle sharing vertices 0,1
    ]);
    const faces = [0, 1, 2, 3, 4, 5];
    const normals = surfaceNormals(positions, faces);
    for (const value of normals) {
      assert.ok(Number.isFinite(value));
    }
  });

  test("reuses a provided output buffer instead of allocating a new one", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const out = new Float32Array(9).fill(99);
    const result = surfaceNormals(positions, [0, 1, 2], out);
    assert.equal(result, out);
    assert.ok(Math.abs(out[2] - 1) < 1e-6);
  });
});

function assertClose(actual, expected, tolerance, label) {
  assert.equal(actual.length, expected.length, label);
  for (let i = 0; i < actual.length; i++) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) < tolerance,
      `${label ?? ""} component ${i}: ${actual[i]} vs ${expected[i]}`,
    );
  }
}

describe("deformHemisphere: blend endpoints and continuity", () => {
  test("folding = 0 reproduces the blob positions exactly, regardless of depth", () => {
    const source = makeHemisphere();
    const prepared = prepareHemisphere(source);
    for (const depth of [0, 1, 2]) {
      const out = deformHemisphere(prepared, { folding: 0, depth });
      assert.deepEqual(Array.from(out), source.blob, `depth=${depth}`);
    }
  });

  test("folding = 0 is unaffected by depth even when sulc is highly non-uniform", () => {
    const source = makeHemisphere({ sulc: [0, 0.9, 0.1, 0.5] });
    const prepared = prepareHemisphere(source);
    const shallow = deformHemisphere(prepared, { folding: 0, depth: 0 });
    const deep = deformHemisphere(prepared, { folding: 0, depth: 2 });
    assert.deepEqual(Array.from(shallow), Array.from(deep));
    assert.deepEqual(Array.from(shallow), source.blob);
  });

  test("folding = 1, depth = 1 reproduces the closed (default) anatomy", () => {
    const source = makeHemisphere({ sulc: [0.1, 0.8, 0.3, 0.5] });
    const prepared = prepareHemisphere(source);
    const out = deformHemisphere(prepared, { folding: 1, depth: 1 });
    assertClose(out, prepared.closed, 1e-4, "folding1/depth1 vs closed");
  });

  test("folding = 1, depth = 2 reproduces the original, open pial surface", () => {
    const source = makeHemisphere({ sulc: [0.1, 0.8, 0.3, 0.5] });
    const prepared = prepareHemisphere(source);
    const out = deformHemisphere(prepared, { folding: 1, depth: 2 });
    assertClose(out, source.vertices, 1e-4, "folding1/depth2 vs source.vertices");
  });

  test("folding = 1, depth = 0 reproduces the shallow (further-closed) anatomy exactly", () => {
    const source = makeHemisphere({ sulc: [0.1, 0.8, 0.3, 0.5] });
    const prepared = prepareHemisphere(source);
    const out = deformHemisphere(prepared, { folding: 1, depth: 0 });
    assertClose(out, prepared.shallow, 1e-4, "folding1/depth0 vs shallow");
  });

  test("the blend is continuous across the depth = 1 join at folding = 1", () => {
    const source = makeHemisphere({ sulc: [0.1, 0.8, 0.3, 0.5] });
    const prepared = prepareHemisphere(source);
    const before = deformHemisphere(prepared, { folding: 1, depth: 1 - 1e-4 });
    const at = deformHemisphere(prepared, { folding: 1, depth: 1 });
    const after = deformHemisphere(prepared, { folding: 1, depth: 1 + 1e-4 });
    assertClose(before, at, 1e-2, "before->at");
    assertClose(after, at, 1e-2, "at->after");
  });

  test("the blend is continuous across the folding = 0 join at every depth", () => {
    const source = makeHemisphere({ sulc: [0.1, 0.8, 0.3, 0.5] });
    const prepared = prepareHemisphere(source);
    for (const depth of [0, 1, 2]) {
      const before = deformHemisphere(prepared, { folding: 1e-4, depth });
      const at = deformHemisphere(prepared, { folding: 0, depth });
      assertClose(before, at, 1e-2, `depth=${depth}`);
    }
  });
});

describe("deformHemisphere: anatomical closure", () => {
  test("opposing gyral walls across a sulcus move toward each other (the valley narrows)", () => {
    // Two small triangular "walls" facing each other across a gap, deep
    // inside one hemisphere (large, same-signed x, so the medial-fissure
    // step for the whole-brain midline cannot confound the read). Each
    // wall's geometric normal faces the opposing wall, as a real gyral wall
    // facing into a sulcus would. inflated === vertices isolates the normal
    // push from the softening blend.
    const c = -30;
    const vertices = [
      c, -5, 0, // wall A (faces +y, toward wall B)
      c, -5, 1,
      c + 1, -5, 0,
      c, 5, 0, // wall B (faces -y, toward wall A)
      c, 5, 1,
      c + 1, 5, 0,
    ];
    const inflated = [...vertices];
    const blob = [...vertices];
    const sulc = new Array(6).fill(0); // unused by closure now, shading only
    const faces = [0, 1, 2, 3, 5, 4];
    const source = { vertices, faces, sulc, inflated, blob };
    const prepared = prepareHemisphere(source);

    const wallAyBefore = vertices[1];
    const wallByBefore = vertices[10];
    const gapBefore = Math.abs(wallByBefore - wallAyBefore);

    const wallAyAfter = prepared.closed[1];
    const wallByAfter = prepared.closed[10];
    const gapAfter = Math.abs(wallByAfter - wallAyAfter);

    assert.ok(gapAfter < gapBefore, `expected the sulcus to narrow: ${gapAfter} vs ${gapBefore}`);
    // Each wall individually moves toward the other, not just a size change.
    assert.ok(wallAyAfter > wallAyBefore, "wall A should move toward wall B (+y)");
    assert.ok(wallByAfter < wallByBefore, "wall B should move toward wall A (-y)");

    // The shallow anatomy (depth=0) must stay at least as closed as the
    // closed default (depth=1) — the sulcus should never reopen while
    // flattening toward depth=0.
    const wallAyShallow = prepared.shallow[1];
    const wallByShallow = prepared.shallow[10];
    const gapShallow = Math.abs(wallByShallow - wallAyShallow);
    assert.ok(
      gapShallow <= gapAfter,
      `expected the shallow gap to be no wider than the closed gap: ${gapShallow} vs ${gapAfter}`,
    );
  });

  test("closure keeps a non-trivial medial fissure (coordinates never collapse to exactly 0)", () => {
    const source = makeHemisphere({ vertexCount: 6, sulc: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9] });
    const prepared = prepareHemisphere(source);
    for (let v = 0; v < source.vertices.length / 3; v++) {
      assert.notEqual(prepared.closed[v * 3], 0, `vertex ${v} x collapsed onto the midline`);
    }
  });

  test("closure does not mutate the original source arrays", () => {
    const source = makeHemisphere({ sulc: [0.1, 0.8, 0.3, 0.5] });
    const beforeVertices = [...source.vertices];
    const beforeBlob = [...source.blob];
    const beforeInflated = [...source.inflated];
    const beforeSulc = [...source.sulc];
    const prepared = prepareHemisphere(source);
    deformHemisphere(prepared, { folding: 1, depth: 0 });
    deformHemisphere(prepared, { folding: 0.5, depth: 1.7 });
    assert.deepEqual(source.vertices, beforeVertices);
    assert.deepEqual(source.blob, beforeBlob);
    assert.deepEqual(source.inflated, beforeInflated);
    assert.deepEqual(source.sulc, beforeSulc);
    assert.equal(prepared.source, source);
  });
});

describe("deformHemisphere: parameter bounds", () => {
  test("out-of-range folding and depth are clamped to FOLDING_LIMITS", () => {
    const source = makeHemisphere();
    const prepared = prepareHemisphere(source);
    const clampedHigh = deformHemisphere(prepared, { folding: 50, depth: 50 });
    const atLimits = deformHemisphere(prepared, {
      folding: FOLDING_LIMITS.folding[1],
      depth: FOLDING_LIMITS.depth[1],
    });
    assert.deepEqual(Array.from(clampedHigh), Array.from(atLimits));

    const clampedLow = deformHemisphere(prepared, { folding: -50, depth: -50 });
    const atLowLimits = deformHemisphere(prepared, {
      folding: FOLDING_LIMITS.folding[0],
      depth: FOLDING_LIMITS.depth[0],
    });
    assert.deepEqual(Array.from(clampedLow), Array.from(atLowLimits));
  });

  test("non-finite parameters fall back to DEFAULT_FOLDING and produce finite output", () => {
    const source = makeHemisphere();
    const prepared = prepareHemisphere(source);
    const fallback = deformHemisphere(prepared, { folding: NaN, depth: NaN });
    const expected = deformHemisphere(prepared, DEFAULT_FOLDING);
    assert.deepEqual(Array.from(fallback), Array.from(expected));
    for (const v of fallback) assert.ok(Number.isFinite(v));
  });

  test("output is always finite across a sweep of valid parameter combinations", () => {
    const source = makeHemisphere();
    const prepared = prepareHemisphere(source);
    for (let folding = 0; folding <= 1; folding += 0.1) {
      for (let depth = 0; depth <= 2; depth += 0.2) {
        const out = deformHemisphere(prepared, { folding, depth });
        for (const v of out) {
          assert.ok(Number.isFinite(v), `folding=${folding} depth=${depth} -> ${v}`);
        }
      }
    }
  });
});

describe("toDisplayPositions", () => {
  test("left hemisphere x is clamped at most to -0.003 (keeps a visible fissure)", () => {
    const mm = new Float32Array([0, 0, 0, -5, 10, 20, 50, 0, 0]);
    const out = toDisplayPositions(mm, "left");
    assert.ok(out[0] <= -0.003);
    assert.ok(out[3] <= -0.003);
    assert.ok(out[6] <= -0.003);
  });

  test("right hemisphere x is clamped at least to 0.003 (mirrors the left fissure)", () => {
    const mm = new Float32Array([0, 0, 0, 5, 10, 20, -50, 0, 0]);
    const out = toDisplayPositions(mm, "right");
    assert.ok(out[0] >= 0.003);
    assert.ok(out[3] >= 0.003);
    assert.ok(out[6] >= 0.003);
  });

  test("left and right never produce overlapping/crossing x at the fissure for the same input magnitude", () => {
    const mm = new Float32Array([-1, 0, 0]);
    const mmMirrored = new Float32Array([1, 0, 0]);
    const left = toDisplayPositions(mm, "left");
    const right = toDisplayPositions(mmMirrored, "right");
    assert.ok(left[0] < right[0]);
  });

  test("y and z scale linearly and independently of hemisphere side", () => {
    const mm = new Float32Array([0, 10, 20]);
    const left = toDisplayPositions(mm, "left");
    const right = toDisplayPositions(mm, "right");
    assert.ok(Math.abs(left[1] - right[1]) < 1e-6);
    assert.ok(Math.abs(left[2] - right[2]) < 1e-6);
    // y scales by (0.92*0.97/74), z is offset by -8mm first then scaled by 0.011.
    const expectedY = 10 * (0.92 * 0.97 / 74);
    const expectedZ = (20 - 8) * 0.011;
    assert.ok(Math.abs(left[1] - expectedY) < 1e-6);
    assert.ok(Math.abs(left[2] - expectedZ) < 1e-6);
  });

  test("reuses a provided output buffer", () => {
    const mm = new Float32Array([-1, 2, 3]);
    const out = new Float32Array(3);
    const result = toDisplayPositions(mm, "left", out);
    assert.equal(result, out);
  });
});

describe("scanRevealRadius", () => {
  test("starts at 0 and reaches the full radius of 3 by 1.4s", () => {
    assert.equal(scanRevealRadius(0), 0);
    assert.equal(scanRevealRadius(1400), 3);
  });

  test("clamps before 0ms and after 1.4s (no overshoot or negative radius)", () => {
    assert.equal(scanRevealRadius(-500), 0);
    assert.equal(scanRevealRadius(5000), 3);
  });

  test("is monotonically non-decreasing over the reveal window", () => {
    let previous = -Infinity;
    for (let t = 0; t <= 1400; t += 50) {
      const radius = scanRevealRadius(t);
      assert.ok(radius >= previous - 1e-9, `radius decreased at t=${t}`);
      previous = radius;
    }
  });

  test("reduced motion skips the animation and returns the final radius immediately", () => {
    assert.equal(scanRevealRadius(0, true), 3);
    assert.equal(scanRevealRadius(700, true), 3);
  });
});

describe("real fsaverage5 mesh sanity", () => {
  // Checked-in required asset: a missing or malformed file should fail the
  // suite outright, not be silently skipped.
  const meshPath = path.join(__dirname, "..", "public", "models", "fsaverage5.json");
  const mesh = JSON.parse(readFileSync(meshPath, "utf8"));

  test("left and right hemispheres load with matching, non-empty array shapes", () => {
    for (const side of ["left", "right"]) {
      const h = mesh[side];
      assert.ok(h.vertices.length > 0);
      assert.equal(h.vertices.length, h.inflated.length);
      assert.equal(h.vertices.length, h.blob.length);
      assert.equal(h.vertices.length % 3, 0);
      assert.equal(h.sulc.length, h.vertices.length / 3);
      assert.equal(h.faces.length % 3, 0);
    }
  });

  for (const side of ["left", "right"]) {
    test(`${side} hemisphere: deformed geometry and normals stay finite across the parameter range`, () => {
      const prepared = prepareHemisphere(mesh[side]);
      for (const folding of [0, 0.25, 0.5, 0.75, 1]) {
        for (const depth of [0, 1, 2]) {
          const deformed = deformHemisphere(prepared, { folding, depth });
          for (const v of deformed) {
            assert.ok(Number.isFinite(v));
          }
          const normals = surfaceNormals(deformed, mesh[side].faces);
          for (let i = 0; i < normals.length; i += 3) {
            const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
            assert.ok(len === 0 || Math.abs(len - 1) < 1e-4, `non-unit normal length ${len}`);
          }
        }
      }
    });

    test(`${side} hemisphere: display-space coordinates stay on this side of the midline fissure`, () => {
      const prepared = prepareHemisphere(mesh[side]);
      const deformed = deformHemisphere(prepared, DEFAULT_FOLDING);
      const display = toDisplayPositions(deformed, side);
      for (let i = 0; i < display.length; i += 3) {
        if (side === "left") {
          assert.ok(display[i] <= -0.003, `vertex ${i / 3} crossed into the right hemisphere`);
        } else {
          assert.ok(display[i] >= 0.003, `vertex ${i / 3} crossed into the left hemisphere`);
        }
      }
    });
  }
});
