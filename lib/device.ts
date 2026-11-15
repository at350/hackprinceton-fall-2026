import { deviceBuffer } from "./mock";
import { type Mode, getMode, modeDef } from "./mode";
import { type BridgeStatus, type DevicePresence, presenceFrom, sameStatus } from "./device-status";
import type { DeviceSample } from "./types";

// The Lucid device, as the dashboard sees it: the device bridge (agent/lucid/device,
// `python -m lucid.device`) answers whether a probe is there, streams its samples
// for the charts and tracks which spots the medic has read.

export const DEVICE_URL = (process.env.NEXT_PUBLIC_DEVICE_URL ?? "http://localhost:2025").replace(/\/$/, "");

export { presenceFrom, sameStatus, spotsFrom } from "./device-status";
export type { BridgeStatus, DevicePresence } from "./device-status";

let status: BridgeStatus | null = null;
let seq = 0;

export const bridgeStatus = () => status;
export const deviceStatus = (): DevicePresence => presenceFrom(status);

/** The device a mode scans with: always there when simulated, the bridge's answer otherwise. */
export function devicePresence(mode: Mode): DevicePresence {
  return modeDef(mode).source === "mock" ? { connected: true, reason: "" } : deviceStatus();
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(DEVICE_URL + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error || `The device bridge answered ${res.status}.`);
  return json;
}

/** Begin a scan on the probe: the bridge reads the 8 spots in order as the medic holds each one still. */
export const startDeviceScan = () => call<unknown>("/scan/start", {});

const STATUS_MS = 500;
const SAMPLES_MS = 100;

/**
 * In Device mode, keep the bridge's status current and feed its samples to the charts.
 * `onChange` runs when the status would draw differently. Returns a stop function.
 */
export function watchDevice(onChange: () => void): () => void {
  let busyStatus = false;
  let busySamples = false;
  const inDeviceMode = () => modeDef(getMode()).source === "device";

  const set = (next: BridgeStatus | null) => {
    const changed = !sameStatus(status, next);
    status = next;
    if (!next) seq = 0;
    if (changed) onChange();
  };

  const pollStatus = async () => {
    if (busyStatus) return;
    if (!inDeviceMode()) return set(null);
    busyStatus = true;
    try {
      set(await call<BridgeStatus>("/status"));
    } catch {
      set(null);
    } finally {
      busyStatus = false;
    }
  };

  const pollSamples = async () => {
    if (busySamples || !status?.connected || !inDeviceMode()) return;
    busySamples = true;
    try {
      const { samples } = await call<{ samples: (DeviceSample & { seq: number })[] }>(`/samples?since=${seq}`);
      if (samples.length) {
        // The probe's clock is its own; place the samples on the page's clock, newest = now.
        const now = performance.now();
        const newest = samples[samples.length - 1];
        if (newest.seq < seq) deviceBuffer.clear(); // the bridge restarted
        for (const s of samples) deviceBuffer.push({ ...s, t: now - (newest.t - s.t) });
        seq = newest.seq;
      }
    } catch {
      // the next status poll reports a bridge that went away
    } finally {
      busySamples = false;
    }
  };

  void pollStatus();
  const a = setInterval(() => void pollStatus(), STATUS_MS);
  const b = setInterval(() => void pollSamples(), SAMPLES_MS);
  return () => {
    clearInterval(a);
    clearInterval(b);
  };
}
