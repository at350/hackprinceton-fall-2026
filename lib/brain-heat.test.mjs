import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DEMO_BLEED,
  scalpSpot3D,
  bleedCenter3D,
  bleedLikelihood3D,
  scanCoverage3D,
  displayToHead,
  heatAttributes,
} from "../lib/brain-heat.ts";
import { toDisplayPositions } from "../lib/brain-geometry.ts";

function halfMaxDistance(fn, hi = 200) {
  let lo = 0, top = hi;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + top) / 2;
    if (fn(mid) > 0.5) lo = mid;
    else top = mid;
  }
  return (lo + top) / 2;
}

describe("bleedLikelihood3D", () => {
  test("peaks at exactly 1 at the bleed center, for every bleed type", () => {
    for (const type of ["epidural", "subdural", "intraparenchymal"]) {
      const center = bleedCenter3D(45, type);
      assert.equal(bleedLikelihood3D(center, type, 45, 20), 1);
    }
  });

  test("a non-positive or non-finite volume always yields zero likelihood", () => {
    for (const type of ["epidural", "subdural", "intraparenchymal"]) {
      assert.equal(bleedLikelihood3D([0, 0, 0], type, 0, 0), 0);
      assert.equal(bleedLikelihood3D([0, 0, 0], type, 0, -5), 0);
      assert.equal(bleedLikelihood3D([0, 0, 0], type, 0, NaN), 0);
    }
  });

  test("a larger volume raises (or at least does not lower) likelihood at a fixed offset, for every type", () => {
    for (const type of ["epidural", "subdural", "intraparenchymal"]) {
      const center = bleedCenter3D(0, type);
      const offset = [center[0] + 10, center[1] + 5, center[2] + 3];
      const small = bleedLikelihood3D(offset, type, 0, 5);
      const big = bleedLikelihood3D(offset, type, 0, 40);
      assert.ok(big >= small, `${type}: expected a bigger volume to spread further (${big} vs ${small})`);
      assert.ok(big > small, `${type}: expected a strictly larger likelihood at this offset`);
    }
  });

  test("an epidural bleed is a compact lateral lens: tangential and vertical falloff are comparable (not a thin column)", () => {
    const center = bleedCenter3D(0, "epidural");
    const tangentFalloff = halfMaxDistance((t) => bleedLikelihood3D([center[0] + t, center[1], center[2]], "epidural", 0, 22));
    const verticalFalloff = halfMaxDistance((z) => bleedLikelihood3D([center[0], center[1], center[2] + z], "epidural", 0, 22));
    const ratio = tangentFalloff / verticalFalloff;
    assert.ok(ratio > 0.5 && ratio < 2, `expected comparable tangential/vertical extents, got ratio ${ratio}`);
  });

  test("an epidural bleed is near zero far from its layer, at the crown of the head", () => {
    const center = bleedCenter3D(0, "epidural");
    const crownPoint = [center[0], center[1], 80]; // far above the bleed's shallow layer
    assert.ok(bleedLikelihood3D(crownPoint, "epidural", 0, 22) < 0.01);
  });

  test("likelihood is always finite and within [0, 1]", () => {
    for (const type of ["epidural", "subdural", "intraparenchymal"]) {
      for (const point of [[0, 0, 0], [100, -50, 30], [-66.2, 74, -2]]) {
        const value = bleedLikelihood3D(point, type, 123, 15);
        assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `${type} at ${point}: ${value}`);
      }
    }
  });
});

describe("scanCoverage3D", () => {
  test("is radially symmetric around a scalp spot (depends only on distance)", () => {
    const spot = scalpSpot3D(2);
    const offsets = [
      [10, 0, 0],
      [0, 10, 0],
      [-10, 0, 0],
      [0, 0, 10],
    ];
    const coverages = offsets.map(([dx, dy, dz]) => scanCoverage3D([spot[0] + dx, spot[1] + dy, spot[2] + dz], [2]));
    for (const value of coverages) {
      assert.ok(Math.abs(value - coverages[0]) < 1e-9, `expected equal coverage at equal distance: ${coverages}`);
    }
  });

  test("coverage is exactly 0 for an empty spot list", () => {
    assert.equal(scanCoverage3D([0, 0, 0], []), 0);
  });

  test("coverage is highest exactly at a covered spot and decays with distance", () => {
    const spot = scalpSpot3D(0);
    const atSpot = scanCoverage3D(spot, [0]);
    const near = scanCoverage3D([spot[0] + 20, spot[1], spot[2]], [0]);
    const far = scanCoverage3D([spot[0] + 200, spot[1], spot[2]], [0]);
    assert.ok(atSpot >= near, `coverage should be maximal at the spot itself: ${atSpot} vs ${near}`);
    assert.ok(near >= far, `coverage should decay with distance: ${near} vs ${far}`);
  });

  test("stays clamped to [0, 1] for any input", () => {
    for (const point of [[0, 0, 0], [1000, 1000, 1000], [-1000, -1000, -1000]]) {
      const value = scanCoverage3D(point, [0, 2, 4, 6]);
      assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
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

describe("scalpSpot3D / bleedCenter3D", () => {
  test("scalp spots trace a circle of constant radius in the x/y plane, at a fixed z", () => {
    for (let spot = 0; spot < 8; spot++) {
      const [x, y, z] = scalpSpot3D(spot);
      const radius = Math.hypot(x / 66.2, y / 74);
      assert.ok(Math.abs(radius - 1) < 1e-6, `spot ${spot} off the unit ellipse: ${radius}`);
      assert.equal(z, 15);
    }
  });

  test("bleed centers for intraparenchymal bleeds sit closer to the midline than other types", () => {
    const deep = bleedCenter3D(90, "intraparenchymal");
    const shallow = bleedCenter3D(90, "epidural");
    assert.ok(Math.hypot(deep[0], deep[1]) < Math.hypot(shallow[0], shallow[1]));
  });
});

describe("DEMO_BLEED", () => {
  test("is a well-formed bleed descriptor", () => {
    assert.ok(["epidural", "subdural", "intraparenchymal"].includes(DEMO_BLEED.type));
    assert.ok(Number.isFinite(DEMO_BLEED.angle));
    assert.ok(Number.isFinite(DEMO_BLEED.volume) && DEMO_BLEED.volume > 0);
  });
});

describe("heatAttributes", () => {
  test("produces finite, correctly shaped output for an arbitrary set of display-space points", () => {
    const positions = new Float32Array([-0.2, 0.1, -0.05, 0.25, -0.1, 0.02]);
    const previous = [0, 2];
    const next = [0, 2, 4];
    const result = heatAttributes(positions, previous, next);
    assert.equal(result.heat.length, 2);
    assert.equal(result.before.length, 2);
    assert.equal(result.after.length, 2);
    assert.equal(result.head.length, 6);
    for (const arr of [result.heat, result.before, result.after, result.head]) {
      for (const v of arr) assert.ok(Number.isFinite(v));
    }
    // heat is derived from DEMO_BLEED via bleedLikelihood3D, so it must stay in [0.09, 1].
    for (const v of result.heat) assert.ok(v >= 0.09 && v <= 1);
  });

  test("scanning more spots never reduces coverage at a fixed point", () => {
    const positions = new Float32Array([0.1, 0.1, 0.0]);
    const fewer = heatAttributes(positions, [0], [0]);
    const more = heatAttributes(positions, [0], [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.ok(more.after[0] >= fewer.after[0]);
  });
});
