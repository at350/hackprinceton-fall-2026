import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { presenceFrom, sameStatus, spotsFrom } from "../lib/device-status.ts";
import { initialSpots } from "../lib/mock.ts";

const status = (over = {}) => ({ connected: true, reason: "", calibrated: true, scanning: false, spot: null, done: [], complete: false, seq: 0, ...over });

describe("presenceFrom", () => {
  test("no bridge: not connected, and says the bridge is not running", () => {
    assert.deepEqual(presenceFrom(null), { connected: false, reason: "No device bridge running" });
  });

  test("no probe: the bridge's own reason", () => {
    assert.deepEqual(presenceFrom(status({ connected: false, reason: "No probe found on USB" })), { connected: false, reason: "No probe found on USB" });
    assert.equal(presenceFrom(status({ connected: false, reason: "" })).reason, "No probe connected");
  });

  test("a probe that is not calibrated cannot scan", () => {
    assert.deepEqual(presenceFrom(status({ calibrated: false })), { connected: false, reason: "Probe not calibrated" });
  });

  test("a calibrated probe is ready", () => {
    assert.deepEqual(presenceFrom(status()), { connected: true, reason: "" });
  });
});

describe("spotsFrom", () => {
  test("read spots are done, the one being read is current, the rest are next", () => {
    const spots = spotsFrom(initialSpots(), status({ scanning: true, spot: 3, done: [0, 1, 2] }));
    assert.deepEqual(spots.map((s) => s.state), ["done", "done", "done", "current", "next", "next", "next", "next"]);
    assert.deepEqual(spots.map((s) => s.name), initialSpots().map((s) => s.name));
  });

  test("a re-scan marks only the spot being read again", () => {
    const spots = spotsFrom(initialSpots(), status({ scanning: true, spot: 5, done: [0, 1, 2, 3, 4, 7] }));
    assert.equal(spots[5].state, "current");
    assert.equal(spots[6].state, "next");
  });

  test("a finished scan has no current spot", () => {
    const spots = spotsFrom(initialSpots(), status({ complete: true, done: [0, 1, 2, 3, 4, 5, 6, 7] }));
    assert.ok(spots.every((s) => s.state === "done"));
  });
});

describe("sameStatus", () => {
  test("ignores the sample counter, notices everything the dashboard draws", () => {
    assert.equal(sameStatus(status({ seq: 1 }), status({ seq: 900 })), true);
    assert.equal(sameStatus(status(), status({ spot: 2, scanning: true })), false);
    assert.equal(sameStatus(status({ done: [0] }), status({ done: [0, 1] })), false);
    assert.equal(sameStatus(null, null), true);
    assert.equal(sameStatus(null, status()), false);
  });
});
