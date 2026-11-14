import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { scalpSpot3D, displayToHead, projectAxialMap, mapTextureData, mapVertexAttributes } from "../lib/brain-heat.ts";
import { toDisplayPositions } from "../lib/brain-geometry.ts";
import { polar } from "../lib/mock.ts";

function toDegrees(radians) {
  let degrees = (radians * 180) / Math.PI;
  if (degrees < 0) degrees += 360;
  return degrees;
}

describe("scalpSpot3D", () => {
  test("traces a circle of constant radius in the x/y plane, at a fixed z", () => {
    for (let spot = 0; spot < 8; spot++) {
      const [x, y, z] = scalpSpot3D(spot);
      const radius = Math.hypot(x / 66.2, y / 74);
      assert.ok(Math.abs(radius - 1) < 1e-6, `spot ${spot} off the unit ellipse: ${radius}`);
      assert.equal(z, 15);
    }
  });

  test("is symmetric: opposite spots sit at opposite points", () => {
    for (let spot = 0; spot < 4; spot++) {
      const a = scalpSpot3D(spot);
      const b = scalpSpot3D(spot + 4);
      assert.ok(Math.abs(a[0] + b[0]) < 1e-9);
      assert.ok(Math.abs(a[1] + b[1]) < 1e-9);
    }
  });
});

describe("displayToHead", () => {
  test("inverts each axis of toDisplayPositions' scaling independently", () => {
    const point = [0.1, 0.2, 0.3];
    const head = displayToHead(point);
    assert.ok(Math.abs(head[0] - point[0] / (0.676 * 0.97 / 66.2)) < 1e-9);
    assert.ok(Math.abs(head[1] - point[1] / (0.92 * 0.97 / 74)) < 1e-9);
    assert.ok(Math.abs(head[2] - (point[2] / 0.011 + 8)) < 1e-9);
  });

  test("round-trips through toDisplayPositions for a point far enough from the fissure clamp", () => {
    const mm = [-50, 30, 10]; // |x| far from the ±0.003 display-space clamp
    const display = toDisplayPositions(new Float32Array(mm), "left");
    const back = displayToHead([display[0], display[1], display[2]]);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(back[i] - mm[i]) < 1e-3, `axis ${i}: ${back[i]} vs ${mm[i]}`);
    }
  });
});

describe("projectAxialMap", () => {
  test("the crown (directly above center) maps to the exact texture centre", () => {
    const result = projectAxialMap([0, 0, 60]);
    assert.equal(result.u, 0.5);
    assert.equal(result.v, 0.5);
    assert.equal(result.radius, 0);
  });

  test("any point on the lateral equator (z = 8) has radius exactly 0.97, fit to the head ellipse", () => {
    for (const [x, y] of [[50, 0], [0, 50], [-50, 0], [0, -50], [35, 35], [35, -35]]) {
      const result = projectAxialMap([x, y, 8]);
      assert.ok(Math.abs(result.radius - 0.97) < 1e-9, `(${x},${y}): radius ${result.radius}`);
      // The projected (u, v) itself must land on the fitted head ellipse, not
      // just report radius=0.97 as a number: reuse the app's own ellipse
      // metric (mock.polar, same aspect ratio) to confirm the shape.
      const mapX = result.u * 2 - 1, mapY = result.v * 2 - 1;
      assert.ok(Math.abs(polar(mapX, mapY).r - 0.97) < 1e-9, `(${x},${y}) not on the fitted ellipse`);
    }
  });

  test("raw azimuth matches mock.polar's convention (0 = nose, clockwise from above), including diagonals", () => {
    const directions = [
      [0, 50, "nose"],
      [50, 0, "right"],
      [0, -50, "back"],
      [-50, 0, "left"],
      [35, 35, "nose-right diagonal"],
      [35, -35, "back-right diagonal"],
      [-35, 35, "nose-left diagonal"],
      [-35, -35, "back-left diagonal"],
    ];
    for (const [x, y, label] of directions) {
      const result = projectAxialMap([x, y, 8]);
      const mapX = result.u * 2 - 1, mapY = result.v * 2 - 1;
      const expected = polar(mapX, mapY).a;
      assert.ok(Math.abs(toDegrees(result.angle) - expected) < 1e-6, `${label}: ${toDegrees(result.angle)} vs ${expected}`);
    }
  });

  test("radius grows monotonically from the crown, through the equator, down the lateral wall, without clamping at the rim", () => {
    let previous = -Infinity;
    for (const z of [80, 60, 40, 20, 8, 0, -10, -30]) {
      const result = projectAxialMap([50, 0, z]);
      assert.ok(result.radius > previous, `radius did not increase at z=${z}: ${result.radius} <= ${previous}`);
      previous = result.radius;
    }
    // The final (lowest) point is well past the equator, radius keeps rising
    // past 0.97 instead of being clamped to the rim.
    assert.ok(previous > 0.97);
  });

  test("below-equator radius mirrors above-equator radius around the equator value (no one-sided streak)", () => {
    // atan2(c, t) + atan2(c, -t) = pi exactly for c > 0, so for any lateral
    // azimuth the radius above and below the equator by the same |dz| must
    // sum to exactly twice the equator radius — an exact symmetry, not an
    // approximation, and the reason a round 3D blob near the equator stays a
    // round (not streaked) blob in the map.
    const equator = projectAxialMap([66.2 * 0.8, 0, 8]).radius;
    for (const dz of [1, 5, 15, 40]) {
      const above = projectAxialMap([66.2 * 0.8, 0, 8 + dz]).radius;
      const below = projectAxialMap([66.2 * 0.8, 0, 8 - dz]).radius;
      assert.ok(Math.abs(above + below - 2 * equator) < 1e-9, `dz=${dz}: ${above} + ${below} != 2*${equator}`);
    }
  });

  test("a compact lateral blob has a comparable (not wildly anisotropic) azimuthal vs. vertical footprint", () => {
    // Small 3D neighborhood around one lateral equator point: nudge it
    // azimuthally (rotate around z) and vertically (shift z), and compare the
    // resulting displacement in map space. A "streak" would show one
    // direction's displacement dwarfing the other by orders of magnitude;
    // a compact blob keeps them within the same order of magnitude.
    const radiusHead = 66.2 * 0.99;
    const base = [radiusHead, 0, 8];
    const toMap = ([x, y, z]) => {
      const p = projectAxialMap([x, y, z]);
      return [p.u * 2 - 1, p.v * 2 - 1];
    };
    const center = toMap(base);

    const azimuthDeg = 5, rad = (azimuthDeg * Math.PI) / 180;
    const azimuthNeighbor = [base[0] * Math.cos(rad) - base[1] * Math.sin(rad), base[0] * Math.sin(rad) + base[1] * Math.cos(rad), base[2]];
    const azimuthPoint = toMap(azimuthNeighbor);
    const azimuthDistance = Math.hypot(azimuthPoint[0] - center[0], azimuthPoint[1] - center[1]);

    const verticalPoint = toMap([base[0], base[1], base[2] + 8]);
    const verticalDistance = Math.hypot(verticalPoint[0] - center[0], verticalPoint[1] - center[1]);

    const ratio = verticalDistance / azimuthDistance;
    assert.ok(ratio > 0.2 && ratio < 5, `expected comparable footprints, got ratio ${ratio} (azimuth ${azimuthDistance}, vertical ${verticalDistance})`);
  });

  test("a compact radial Gaussian blob near the left rim (r=.9) projects to one contiguous bright band along its meridian, that fades out below the equator rather than staying pinned at the edge", () => {
    // Place an actual 2D Gaussian "likelihood" field in map space, centered
    // at the left azimuth (270°, matching mock.polar's convention) at
    // radius=.9 — near the rim, as a real lesion lens would sit — using the
    // same ellipse-fit math projectAxialMap itself uses for radius -> (u,v).
    const RX = 0.676, RY = 0.92;
    const leftAngle = -Math.PI / 2;
    const sin = Math.sin(leftAngle), cos = Math.cos(leftAngle);
    const centerDistance = 0.9 / Math.hypot(sin / RX, cos / RY);
    const centerMapX = sin * centerDistance, centerMapY = -cos * centerDistance;
    const sigma = 0.12;
    function brightnessAt(u, v) {
      const mapX = u * 2 - 1, mapY = v * 2 - 1;
      const dx = mapX - centerMapX, dy = mapY - centerMapY;
      return Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
    }

    // Walk the corresponding meridian in head space: fixed left azimuth
    // (x < 0, y = 0), z sweeping from above the crown, through the equator
    // (z = 8), to well below it.
    const lateralX = -60;
    const zs = [];
    for (let z = 70; z >= -60; z -= 1) zs.push(z);
    const samples = zs.map((z) => {
      const { u, v } = projectAxialMap([lateralX, 0, z]);
      return { z, bright: brightnessAt(u, v) };
    });

    const threshold = 0.5;
    const brightIndices = samples.map((s, i) => (s.bright > threshold ? i : -1)).filter((i) => i >= 0);
    assert.ok(brightIndices.length > 0, "expected a non-empty bright interval");
    const first = brightIndices[0], last = brightIndices[brightIndices.length - 1];
    // Bounded: doesn't light up the whole meridian.
    assert.ok(last - first + 1 < samples.length, "bright interval should not span the whole sweep");
    // Contiguous: every index between first and last is also bright (no gaps).
    for (let i = first; i <= last; i++) {
      assert.ok(samples[i].bright > threshold, `gap in the bright interval at z=${samples[i].z}`);
    }

    // The peak sits near the equator (where radius is closest to the
    // Gaussian's r=.9 center) and brightness fades on both sides of it.
    const peakIndex = samples.reduce((best, s, i) => (s.bright > samples[best].bright ? i : best), 0);
    const equatorIndex = samples.findIndex((s) => s.z === 8);
    assert.ok(Math.abs(samples[peakIndex].z - 8) < 15, `expected the peak near the equator, got z=${samples[peakIndex].z}`);

    // Decays below the equator rather than staying pinned at the same
    // brightness: strictly decreasing as z keeps dropping well past it, and
    // the deep sample is much dimmer than the equator sample, not equal to it.
    const belowEquator = samples.slice(equatorIndex, samples.length);
    for (let i = 1; i < belowEquator.length; i++) {
      assert.ok(
        belowEquator[i].bright <= belowEquator[i - 1].bright + 1e-9,
        `brightness should keep falling below the equator: z=${belowEquator[i].z} (${belowEquator[i].bright}) vs z=${belowEquator[i - 1].z} (${belowEquator[i - 1].bright})`,
      );
    }
    const deepBelow = samples[samples.length - 1];
    assert.ok(
      deepBelow.bright < samples[equatorIndex].bright * 0.1,
      `expected real decay well below the equator, got ${deepBelow.bright} vs equator ${samples[equatorIndex].bright}`,
    );
  });

  test("always returns finite output for a range of head-space inputs", () => {
    for (const point of [[0, 0, 0], [66.2, 74, 65], [-66.2, -74, -50], [1e-6, 0, 8]]) {
      const result = projectAxialMap(point);
      assert.ok(Number.isFinite(result.u));
      assert.ok(Number.isFinite(result.v));
      assert.ok(Number.isFinite(result.radius));
      assert.ok(Number.isFinite(result.angle));
    }
  });
});

describe("mapTextureData", () => {
  test("packs likelihood into R and the coverage rule min(1, v/0.06) into G, with full opacity and an empty B channel", () => {
    const result = mapTextureData([[0.5, 1.5], [-1, NaN]]);
    assert.equal(result.size, 2);
    const expectedR = [Math.round(0.5 * 255), 255, 0, 0];
    const expectedG = [255, 255, 0, 0]; // 0.5/0.06 and 1.5/0.06 both exceed 1
    for (let i = 0; i < 4; i++) {
      assert.equal(result.data[i * 4], expectedR[i], `R at pixel ${i}`);
      assert.equal(result.data[i * 4 + 1], expectedG[i], `G at pixel ${i}`);
      assert.equal(result.data[i * 4 + 2], 0, `B at pixel ${i} should be untouched`);
      assert.equal(result.data[i * 4 + 3], 255, `A at pixel ${i} should be opaque`);
    }
  });

  test("a value just under the 0.06 coverage threshold is not yet fully covered", () => {
    const result = mapTextureData([[0.03]]);
    assert.ok(result.data[1] < 255);
    assert.ok(Math.abs(result.data[1] - Math.round((0.03 / 0.06) * 255)) <= 1);
  });

  test("a null map is a fully blank, opaque 1x1 texture", () => {
    const result = mapTextureData(null);
    assert.equal(result.size, 1);
    assert.deepEqual(Array.from(result.data), [0, 0, 0, 255]);
  });

  test("an all-zero map is blank everywhere", () => {
    const result = mapTextureData([[0, 0], [0, 0]]);
    for (const byte of result.data.filter((_, i) => i % 4 !== 3)) assert.equal(byte, 0);
  });

  test("is a pure function of the map argument: re-packing an earlier map (no spot/state arguments) reproduces it exactly", () => {
    const mapA = [[0.1, 0.2], [0.3, 0.4]];
    const mapB = [[0.9, 0.8], [0.7, 0.6]];
    const firstA = mapTextureData(mapA);
    const changedToB = mapTextureData(mapB);
    const secondA = mapTextureData(mapA);
    assert.deepEqual(Array.from(firstA.data), Array.from(secondA.data));
    assert.notDeepEqual(Array.from(firstA.data), Array.from(changedToB.data));
  });

  test("rejects a map with rows of inconsistent length", () => {
    assert.throws(() => mapTextureData([[0, 0], [0]]), RangeError);
  });

  test("rejects a map larger than 512x512", () => {
    const big = Array.from({ length: 513 }, () => new Array(513).fill(0));
    assert.throws(() => mapTextureData(big), RangeError);
  });

  test("every raw value is finite-clamped to [0, 1] before packing", () => {
    // Rows must be square; a 5x5 map with these 5 values repeated per row.
    const square = mapTextureData(Array.from({ length: 5 }, () => [-50, 50, NaN, Infinity, -Infinity]));
    const expectedR = [0, 255, 0, 0, 0]; // -50->0 (finite, clamped); 50->1 (finite, clamped); NaN/Infinity/-Infinity all fail isFinite -> 0
    for (let col = 0; col < 5; col++) {
      assert.equal(square.data[col * 4], expectedR[col], `column ${col}`);
    }
  });
});

describe("mapVertexAttributes", () => {
  test("produces finite uv in [0, 1] and head coordinates consistent with displayToHead + projectAxialMap", () => {
    const positions = new Float32Array([0.1, 0.1, 0.0, -0.2, 0.3, 0.1, 0.05, -0.4, -0.02]);
    const result = mapVertexAttributes(positions);
    const vertexCount = positions.length / 3;
    assert.equal(result.uv.length, vertexCount * 2);
    assert.equal(result.head.length, positions.length);

    for (let i = 0; i < vertexCount; i++) {
      const point = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
      const expectedHead = displayToHead(point);
      for (let axis = 0; axis < 3; axis++) {
        assert.ok(Math.abs(result.head[i * 3 + axis] - expectedHead[axis]) < 1e-4, `vertex ${i} axis ${axis}`);
      }
      const expectedMap = projectAxialMap(expectedHead);
      assert.ok(Math.abs(result.uv[i * 2] - expectedMap.u) < 1e-4, `vertex ${i} u`);
      assert.ok(Math.abs(result.uv[i * 2 + 1] - expectedMap.v) < 1e-4, `vertex ${i} v`);
      assert.ok(result.uv[i * 2] >= 0 && result.uv[i * 2] <= 1);
      assert.ok(result.uv[i * 2 + 1] >= 0 && result.uv[i * 2 + 1] <= 1);
      assert.ok(Number.isFinite(result.head[i * 3]) && Number.isFinite(result.head[i * 3 + 1]) && Number.isFinite(result.head[i * 3 + 2]));
    }
  });

  test("handles zero vertices without error", () => {
    const result = mapVertexAttributes(new Float32Array(0));
    assert.equal(result.uv.length, 0);
    assert.equal(result.head.length, 0);
  });
});
