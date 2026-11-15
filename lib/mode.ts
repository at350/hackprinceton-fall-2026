"use client";

import { useSyncExternalStore } from "react";

// Which device feeds the dashboard. Modes are defined here and nowhere else; a
// new mode is one more entry in MODES.
//   agent:  the real agent drives the dashboard (lib/live.ts). Switching to a mode
//           with a different engine reloads the page, so isAgentMode(getMode())
//           holds for a whole page load.
//   source: where scans come from. "mock": the backend's sample scans, with a simulated
//           signal stream for the charts. "device": the Lucid device, through the
//           device bridge (lib/device.ts).

export interface ModeDef {
  id: string;
  label: string;
  description: string; // one line, in the mode menu
  agent: boolean;
  source: "mock" | "device";
}

export const MODES = [
  { id: "simulated", label: "Simulated device", description: "The agent reads the backend's sample scans.", agent: true, source: "mock" },
  { id: "device", label: "Device", description: "The agent reads the Lucid device, through the device bridge.", agent: true, source: "device" },
] as const satisfies readonly ModeDef[];

export type Mode = (typeof MODES)[number]["id"];

const DEFAULT: Mode = MODES[0].id;
const KEY = "lucid.mode";

export const isMode = (v: unknown): v is Mode => MODES.some((m) => m.id === v);
export const modeDef = (mode: Mode): ModeDef => MODES.find((m) => m.id === mode)!;
export const isAgentMode = (mode: Mode) => modeDef(mode).agent;

/** `?mode=`, or `?live=1` (the old live flag), else the mode last used, else the first. */
export function resolveMode(search: string, saved: string | null): Mode {
  const q = new URLSearchParams(search);
  const asked = q.get("mode");
  if (isMode(asked)) return asked;
  if (q.get("live") === "1") return "simulated";
  return isMode(saved) ? saved : DEFAULT;
}

/** Kept for the next visit, and shown in the address bar. */
function remember(mode: Mode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {}
  const url = new URL(location.href);
  url.searchParams.delete("live");
  url.searchParams.set("mode", mode);
  if (url.href !== location.href) history.replaceState(null, "", url);
}

let current: Mode = DEFAULT;
if (typeof window !== "undefined") {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {}
  current = resolveMode(location.search, saved);
  remember(current);
}
const listeners = new Set<() => void>();

export const getMode = () => current;

export function subscribeMode(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function useMode(): Mode {
  return useSyncExternalStore(subscribeMode, getMode, getMode);
}

export function setMode(mode: Mode) {
  if (mode === current) return;
  const engine = isAgentMode(mode) !== isAgentMode(current);
  current = mode;
  remember(mode);
  // Another engine drives the dashboard: start the page over in it.
  if (engine) return location.reload();
  for (const fn of listeners) fn();
}
