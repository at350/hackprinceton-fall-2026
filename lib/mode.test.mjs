import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { MODES, getMode, isAgentMode, isMode, modeDef, resolveMode } from "../lib/mode.ts";

describe("MODES", () => {
  test("lists Simulated device first, then Device, both driven by the agent", () => {
    assert.deepEqual(MODES.map((m) => [m.id, m.label, m.agent, m.source]), [
      ["simulated", "Simulated device", true, "mock"],
      ["device", "Device", true, "device"],
    ]);
  });

  test("every mode has a one-line description", () => {
    for (const m of MODES) assert.ok(m.description && !m.description.includes("\n"), m.id);
  });

  test("modeDef and isAgentMode read the list", () => {
    assert.equal(modeDef("device").label, "Device");
    assert.equal(isAgentMode("simulated"), true);
    assert.equal(isAgentMode("device"), true);
  });

  test("isMode accepts only listed ids", () => {
    assert.equal(isMode("simulated"), true);
    assert.equal(isMode("demo"), false);
    assert.equal(isMode(null), false);
  });
});

describe("resolveMode", () => {
  test("?mode= wins over the saved mode", () => {
    assert.equal(resolveMode("?mode=device", "simulated"), "device");
    assert.equal(resolveMode("?view=trace&mode=simulated", "device"), "simulated");
  });

  test("?live=1, the old live flag, is Simulated device", () => {
    assert.equal(resolveMode("?live=1", "device"), "simulated");
    assert.equal(resolveMode("?mode=device&live=1", null), "device");
  });

  test("without a flag, the mode last used", () => {
    assert.equal(resolveMode("", "device"), "device");
    assert.equal(resolveMode("?view=trace", "simulated"), "simulated");
  });

  test("an unknown or missing mode falls back to Simulated device", () => {
    assert.equal(resolveMode("?mode=demo", null), "simulated");
    assert.equal(resolveMode("?live=0", "nonsense"), "simulated");
    assert.equal(resolveMode("", null), "simulated");
  });
});

test("outside a browser the mode is the default", () => {
  assert.equal(getMode(), "simulated");
});
