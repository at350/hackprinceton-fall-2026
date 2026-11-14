"use client";
import { preload } from "react-dom";
import { CORTEX_URL } from "@/lib/brain-model";
/** Start the lazy model request while the application shell is rendering. */
export function CortexPreload() {
  preload(CORTEX_URL, { as: "fetch", crossOrigin: "anonymous" });
  return null;
}
