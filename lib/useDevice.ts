"use client";

import { useEffect, useState } from "react";
import { deviceBuffer } from "./mock";
import type { DeviceSample } from "./types";

/** Latest device sample, polled at ~8 Hz (the charts read the buffer directly). */
export function useLatestSample(live: boolean) {
  const [s, setS] = useState<DeviceSample | null>(null);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setS(deviceBuffer.latest), 120);
    return () => clearInterval(id);
  }, [live]);
  return live ? s : null;
}
