import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { briefContext, briefReady } from "../lib/gemini.ts";

const map = (n) => Array.from({ length: n }, () => Array(n).fill(0));
const sim = (id, score, extra = {}) => ({
  id, type: "epidural", region: "L temporal", volume_ml: 20, status: "done", score, map: map(32), agent: "temporal", progress: 1, ...extra,
});
const state = (over = {}) => ({
  run: 1, view: "dashboard", t: 0, device: "connected", quality: "good", scanStartedAt: 0, scanEndedAt: 1,
  spots: [{ index: 0, name: "Frontal", angle: 0, state: "done", peak: 0.12345 }],
  currentSpot: null, scan: null, sims: [], agents: [], steps: [], messages: [], approval: null, tab: "scan", tabPinnedByUser: false,
  ...over,
});

describe("briefContext", () => {
  test("keeps the numbers, drops the maps, ranks the best fits", () => {
    const s = state({
      scan: { spot: 7, done: true, map: map(64), status: "bleed", region: "L temporal", volume_ml: 22, confidence: 0.8712 },
      sims: [sim("a", 0.4), sim("b", 0.9, { note: "x".repeat(500) }), { ...sim("c", 0.99), status: "running" }],
      messages: [{ id: "1", role: "agent", text: "Left temporal bleed fits best.", shown: 0 }, { id: "2", role: "medic", text: "ok", shown: 0 }],
    });
    const c = briefContext(s, "simulated");
    assert.deepEqual(c.result, { status: "bleed", region: "L temporal", volume_ml: 22, confidence: 0.871 });
    assert.deepEqual(c.best_fits.map((x) => x.fit), [0.9, 0.4]);
    assert.equal(c.best_fits[0].note.length, 200);
    assert.deepEqual(c.agent_said, ["Left temporal bleed fits best."]);
    assert.equal(c.spots[0].peak_likelihood, 0.123);
    assert.ok(!JSON.stringify(c).includes("map"));
  });

  test("names the device mode", () => {
    assert.equal(briefContext(state(), "device").mode, "probe (Device mode)");
  });
});

describe("briefReady", () => {
  test("waits for the agent's result", () => {
    assert.equal(briefReady(state()), false);
    assert.equal(briefReady(state({ scan: { status: "pending" } })), false);
  });
  test("writes when the medic is asked, or once a result stands", () => {
    assert.equal(briefReady(state({ approval: { id: "1", action: "a", state: "pending" } })), true);
    assert.equal(briefReady(state({ scan: { status: "clear" } })), true);
  });
});
