import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { surfaceNormals, toDisplayPositions, scanRevealRadius } from "../lib/brain-geometry.ts";

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
