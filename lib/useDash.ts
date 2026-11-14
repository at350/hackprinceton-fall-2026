"use client";

import { useSyncExternalStore } from "react";
import { demo } from "./demo";
import type { DashState } from "./types";

/** Subscribe to one slice of the demo state. The selector must return a stable reference. */
export function useDash<T>(select: (s: DashState) => T): T {
  return useSyncExternalStore(
    demo.subscribe,
    () => select(demo.getState()),
    () => select(demo.getState()),
  );
}

export function formatClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
