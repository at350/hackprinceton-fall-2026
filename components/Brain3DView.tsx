"use client";

import { useEffect, useRef, useState } from "react";
import { createBrainScene } from "@/lib/brain-scene";
import { BrainOverlay, type BrainViewProps } from "./BrainView";

export default function Brain3DView({ scan, spots, current, onReady, onFailure }: Omit<BrainViewProps, "run"> & { onReady: () => void; onFailure: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<SVGGElement>(null);
  const scene = useRef<ReturnType<typeof createBrainScene> | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    try {
      scene.current = createBrainScene(canvas.current!, overlay.current!, () => {
        if (active) { setReady(true); onReady(); }
      }, () => { if (active) onFailure(); });
    } catch { onFailure(); }
    return () => { active = false; scene.current?.dispose(); scene.current = null; };
  }, [onReady, onFailure]);
  useEffect(() => { scene.current?.setScan(scan, spots.filter((spot) => spot.state === "done").map((spot) => spot.index)); }, [scan, spots]);

  return (
    <div className="brain-arrival absolute inset-0" style={{ opacity: ready ? 1 : 0, pointerEvents: ready ? "auto" : "none" }}>
      <canvas ref={canvas} className="absolute inset-0 size-full cursor-grab rounded-[14px] outline-offset-[-2px]" style={{ touchAction: "none" }} tabIndex={0} role="img" aria-label="Interactive 3D brain. Drag or use arrow keys to orbit; release to return to the view from above. Home resets the view." />
      <BrainOverlay spots={spots} current={current} groupRef={overlay} />

    </div>
  );
}
