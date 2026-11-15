"use client";

import { useSyncExternalStore } from "react";
import { store } from "./store";
import type { DashState } from "./types";

/** Subscribe to one slice of the dashboard state. The selector must return a stable reference. */
export function useDash<T>(select: (s: DashState) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.getState()),
    () => select(store.getState()),
  );
}

export function formatClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
