import { type Mode, modeDef } from "./mode";

// The Lucid device, as the dashboard sees it. There is no device bridge yet, so
// deviceStatus() is a stub; wiring the bridge in means answering it from there.

export interface DevicePresence {
  connected: boolean;
  reason: string; // why there is no device, shown when not connected
}

export function deviceStatus(): DevicePresence {
  return { connected: false, reason: "No device bridge running" };
}

/** The device a mode scans with: always there when simulated, the bridge's answer otherwise. */
export function devicePresence(mode: Mode): DevicePresence {
  return modeDef(mode).source === "mock" ? { connected: true, reason: "" } : deviceStatus();
}
