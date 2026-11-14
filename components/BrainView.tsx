"use client";

import { useEffect, useRef, useState } from "react";
import { BRAIN_SRC, IMG, drawDimBrain, loadBrain, renderScanned } from "@/lib/brain";
import { pointAt } from "@/lib/mock";
import { IconCheck, IconExclamation } from "./icons";
import type { ScanSpot, ScanUpdate } from "@/lib/types";

// SVG space: map covers [-1, 1]; the view adds room for the spot markers.
const VIEW = 1.25;
const INSET = `${((VIEW - 1) / (2 * VIEW)) * 100}%`;
const MARKER_R = 1.16;
const FILL_MS = 1400;

/** Canvas: dim brain everywhere, lit brain + heat where scanned, growing from the finished spot. */
function BrainCanvas({ scan }: { scan: ScanUpdate | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const prev = useRef<HTMLCanvasElement | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    loadBrain().then(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const canvas = ref.current!;
    const size = Math.round(canvas.clientWidth * devicePixelRatio);
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const next = renderScanned(scan?.map ?? null, size);
    if (!scan) prev.current = null;
    const old = prev.current;

    const p = scan ? pointAt(scan.spot * 45) : { x: 0, y: 0 };
    const cx = ((p.x + 1) / 2) * size;
    const cy = ((p.y + 1) / 2) * size;
    const start = performance.now();
    let raf = 0;
    const frame = () => {
      const k = Math.min(1, (performance.now() - start) / FILL_MS);
      const e = 1 - Math.pow(1 - k, 3);
      ctx.clearRect(0, 0, size, size);
      drawDimBrain(ctx, size, 0.14);
      if (old) ctx.drawImage(old, 0, 0, size, size);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, e * size * 1.5, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(next, 0, 0);
      ctx.restore();
      if (k < 1) raf = requestAnimationFrame(frame);
      else prev.current = next;
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      prev.current = next;
    };
  }, [scan, loaded]);

  const box = { inset: INSET, width: `calc(100% - 2 * ${INSET})`, height: `calc(100% - 2 * ${INSET})` };
  const maskSize = `${IMG * 100}%`;
  return (
    <>
      {/* GenRevive: cool atmospheric haze behind the subject. */}
      <div
        className="absolute rounded-full"
        style={{ ...box, background: "radial-gradient(closest-side, rgba(34,195,230,0.10), transparent 75%)" }}
      />
      <canvas ref={ref} className="absolute" style={box} />
      {/* GenRevive: scan-like grid through the surface, clipped to the brain. */}
      <div
        className="absolute opacity-[0.07]"
        style={{
          ...box,
          backgroundImage: "repeating-linear-gradient(to bottom, rgba(140,220,255,1) 0 1px, transparent 1px 7px)",
          maskImage: `url(${BRAIN_SRC})`,
          WebkitMaskImage: `url(${BRAIN_SRC})`,
          maskMode: "luminance",
          maskSize: `${maskSize} ${maskSize}`,
          WebkitMaskSize: `${maskSize} ${maskSize}`,
          maskPosition: "center",
          WebkitMaskPosition: "center",
          maskRepeat: "no-repeat",
          WebkitMaskRepeat: "no-repeat",
        }}
      />
    </>
  );
}

function Marker({ spot }: { spot: ScanSpot }) {
  const p = pointAt(spot.angle, MARKER_R);
  const r = 0.062;
  const at = { x: p.x - 0.045, y: p.y - 0.045, size: 0.09 };
  switch (spot.state) {
    case "done":
      return (
        <g>
          <circle cx={p.x} cy={p.y} r={r} fill="rgba(20,23,28,0.85)" stroke="rgba(255,255,255,0.22)" strokeWidth={0.005} />
          <IconCheck {...at} style={{ color: "var(--text)" }} />
        </g>
      );
    case "current":
      return (
        <g>
          <circle cx={p.x} cy={p.y} r={r} fill="var(--primary)" />
          <text x={p.x} y={p.y + 0.021} textAnchor="middle" fontSize={0.06} fontWeight={600} fill="#06121a">
            {spot.index + 1}
          </text>
        </g>
      );
    case "rescan":
      return (
        <g>
          <circle cx={p.x} cy={p.y} r={r} fill="rgba(20,23,28,0.85)" stroke="var(--uncertain)" strokeWidth={0.007} />
          <IconExclamation {...at} style={{ color: "var(--uncertain)" }} />
        </g>
      );
    default:
      return (
        <g>
          <circle cx={p.x} cy={p.y} r={r} fill="rgba(20,23,28,0.6)" stroke="rgba(255,255,255,0.14)" strokeWidth={0.005} />
          <text x={p.x} y={p.y + 0.021} textAnchor="middle" fontSize={0.056} fontWeight={500} fill="var(--muted)">
            {spot.index + 1}
          </text>
        </g>
      );
  }
}

export function BrainView({ scan, spots, current, run }: { scan: ScanUpdate | null; spots: ScanSpot[]; current: number | null; run: number }) {
  const vb = `${-VIEW} ${-VIEW} ${VIEW * 2} ${VIEW * 2}`;
  // The stretch of cortex under the coil, as a crisp arc along the brain's edge.
  const senseArc =
    current === null
      ? null
      : Array.from({ length: 13 }, (_, i) => {
          const p = pointAt(current * 45 - 24 + i * 4, 1.04);
          return `${i ? "L" : "M"} ${p.x.toFixed(4)} ${p.y.toFixed(4)}`;
        }).join(" ");
  return (
    <div className="relative" style={{ width: "min(100cqw, 100cqh)", height: "min(100cqw, 100cqh)" }}>
      <BrainCanvas key={run} scan={scan} />
      <svg viewBox={vb} className="absolute inset-0 size-full" role="img" aria-label="Brain from above with bleed-likelihood heatmap and 8 scan spots">
        {senseArc && <path d={senseArc} fill="none" stroke="var(--primary)" strokeWidth={0.012} strokeLinecap="round" />}
        <text x={-0.98} y={0.02} fontSize={0.06} fontWeight={500} fill="var(--muted)" textAnchor="middle">L</text>
        <text x={0.98} y={0.02} fontSize={0.06} fontWeight={500} fill="var(--muted)" textAnchor="middle">R</text>
        {spots.map((s) => (
          <Marker key={s.index} spot={s} />
        ))}
      </svg>
    </div>
  );
}
