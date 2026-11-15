import type { ScanSpot } from "./types";

// What the device bridge reports, and what the dashboard makes of it. Pure functions,
// no runtime imports, so they can be tested with node --test (lib/device.test.mjs).

export interface DevicePresence {
  connected: boolean;
  reason: string; // why there is no device, shown when not connected
}

/** GET /status on the bridge. */
export interface BridgeStatus {
  connected: boolean;
  reason: string;
  calibrated: boolean;
  scanning: boolean;
  spot: number | null; // the spot being read now
  done: number[]; // spots already read
  complete: boolean; // all 8 are in
  seq: number;
}

const NO_BRIDGE = "No device bridge running";

/** Whether a scan can start, and if not, why. A probe that is not calibrated cannot scan. */
export function presenceFrom(status: BridgeStatus | null): DevicePresence {
  if (!status) return { connected: false, reason: NO_BRIDGE };
  if (!status.connected) return { connected: false, reason: status.reason || "No probe connected" };
  if (!status.calibrated) return { connected: false, reason: "Probe not calibrated" };
  return { connected: true, reason: "" };
}

/** The scan panel's spots while the medic reads them on the probe. */
export function spotsFrom(spots: ScanSpot[], status: BridgeStatus): ScanSpot[] {
  return spots.map((s) => ({
    ...s,
    state: status.done.includes(s.index) ? "done" : status.scanning && s.index === status.spot ? "current" : "next",
  }));
}

/** True when two statuses would draw the same dashboard (seq moves with every sample, so it is ignored). */
export function sameStatus(a: BridgeStatus | null, b: BridgeStatus | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.connected === b.connected &&
    a.reason === b.reason &&
    a.calibrated === b.calibrated &&
    a.scanning === b.scanning &&
    a.spot === b.spot &&
    a.complete === b.complete &&
    a.done.join() === b.done.join()
  );
}
