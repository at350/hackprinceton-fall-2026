"use client";

import { useEffect, useRef } from "react";
import { HEAD, pointAt } from "@/lib/mock";
import type { ScanSpot, ScanUpdate } from "@/lib/types";
import { paintGrid } from "./ui";

// SVG space: map covers [-1, 1]; the view adds room for markers.
const VIEW = 1.25;
const INSET = `${((VIEW - 1) / (2 * VIEW)) * 100}%`;
const SKULL_IN = 0.985;
const SKULL_OUT = 1.06;
const MARKER_R = 1.2;
const FILL_MS = 1400;

function ellipsePath(s: number) {
  const rx = HEAD.rx * s;
  const ry = HEAD.ry * s;
  return `M ${-rx} 0 A ${rx} ${ry} 0 1 0 ${rx} 0 A ${rx} ${ry} 0 1 0 ${-rx} 0 Z`;
}

/** Heatmap canvas. New maps fill in as a circle growing from the finished spot. */
function Heatmap({ scan }: { scan: ScanUpdate | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const prev = useRef<HTMLCanvasElement | null>(null);
  const next = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current!;
    if (!prev.current) prev.current = document.createElement("canvas");
    if (!next.current) next.current = document.createElement("canvas");

    if (!scan) {
      prev.current.width = prev.current.height = 1;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    paintGrid(next.current, scan.map);
    const size = canvas.clientWidth * devicePixelRatio;
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    const p = pointAt(scan.spot * 45);
    const cx = ((p.x + 1) / 2) * size;
    const cy = ((p.y + 1) / 2) * size;
    const start = performance.now();
    let raf = 0;
    const frame = () => {
      const k = Math.min(1, (performance.now() - start) / FILL_MS);
      const e = 1 - Math.pow(1 - k, 3);
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(prev.current!, 0, 0, size, size);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, e * size * 1.6, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(next.current!, 0, 0, size, size);
      ctx.restore();
      if (k < 1) raf = requestAnimationFrame(frame);
      else {
        // Promote the finished map so the next update grows over it.
        const swap = prev.current!;
        prev.current = next.current;
        next.current = swap;
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [scan]);

  return <canvas ref={ref} className="absolute" style={{ inset: INSET, width: `calc(100% - 2 * ${INSET})`, height: `calc(100% - 2 * ${INSET})` }} />;
}

function Marker({ spot }: { spot: ScanSpot }) {
  const p = pointAt(spot.angle, MARKER_R);
  const r = 0.072;
  const icon = (d: string, color: string) => (
    <svg x={p.x - 0.045} y={p.y - 0.045} width={0.09} height={0.09} viewBox="0 0 16 16">
      <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  switch (spot.state) {
    case "done":
      return (
        <g>
          <circle cx={p.x} cy={p.y} r={r} fill="#2a2d30" stroke="var(--line-strong)" strokeWidth={0.006} />
          {icon("m3.5 8.3 2.8 2.8 6.2-6.2", "var(--text)")}
        </g>
      );
    case "current":
      return (
        <g>
          <circle cx={p.x} cy={p.y} r={r} fill="none" stroke="var(--primary)" strokeWidth={0.008} className="pulse-ring" style={{ transformOrigin: `${p.x}px ${p.y}px`, transformBox: "view-box" }} />
          <circle cx={p.x} cy={p.y} r={r} fill="var(--primary)" />
          <text x={p.x} y={p.y + 0.024} textAnchor="middle" fontSize={0.068} fontWeight={600} fill="var(--bg)">
            {spot.index + 1}
          </text>
        </g>
      );
    case "rescan":
      return (
        <g>
          <circle cx={p.x} cy={p.y} r={r} fill="var(--panel)" stroke="var(--uncertain)" strokeWidth={0.01} />
          {icon("M8 3.5v5.2M8 11.6v.1", "var(--uncertain)")}
        </g>
      );
    default:
      return (
        <g>
          <circle cx={p.x} cy={p.y} r={r} fill="var(--panel)" stroke="var(--line-strong)" strokeWidth={0.008} strokeDasharray="0.02 0.016" />
          <text x={p.x} y={p.y + 0.024} textAnchor="middle" fontSize={0.064} fontWeight={500} fill="var(--muted)">
            {spot.index + 1}
          </text>
        </g>
      );
  }
}

export function HeadView({ scan, spots, current }: { scan: ScanUpdate | null; spots: ScanSpot[]; current: number | null }) {
  const vb = `${-VIEW} ${-VIEW} ${VIEW * 2} ${VIEW * 2}`;
  const sense = current === null ? null : pointAt(current * 45);
  return (
    <div className="relative" style={{ width: "min(100cqw, 100cqh)", height: "min(100cqw, 100cqh)" }}>
      {/* Under: brain field with hatch where nothing is scanned yet. */}
      <svg viewBox={vb} className="absolute inset-0 size-full" aria-hidden>
        <defs>
          <pattern id="hatch" width="0.04" height="0.04" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="0.04" stroke="rgba(255,255,255,0.06)" strokeWidth="0.008" />
          </pattern>
        </defs>
        <path d={ellipsePath(SKULL_IN)} fill="rgba(255,255,255,0.015)" />
        <path d={ellipsePath(SKULL_IN)} fill="url(#hatch)" />
      </svg>

      <Heatmap scan={scan} />

      {/* Over: skull, landmarks, spots. */}
      <svg viewBox={vb} className="absolute inset-0 size-full" role="img" aria-label="Axial head view with bleed-likelihood heatmap and 8 scan spots">
        <path d={`${ellipsePath(SKULL_OUT)} ${ellipsePath(SKULL_IN)}`} fillRule="evenodd" fill="rgba(255,255,255,0.05)" />
        <path d={ellipsePath(SKULL_OUT)} fill="none" stroke="var(--line-strong)" strokeWidth={0.006} />
        <path d={ellipsePath(SKULL_IN)} fill="none" stroke="var(--line-strong)" strokeWidth={0.006} />
        {/* Nose */}
        <path d={`M -0.08 ${-HEAD.ry * SKULL_OUT + 0.012} L 0 ${-HEAD.ry * SKULL_OUT - 0.09} L 0.08 ${-HEAD.ry * SKULL_OUT + 0.012}`} fill="none" stroke="var(--line-strong)" strokeWidth={0.006} strokeLinejoin="round" />
        {/* Ears */}
        {[-1, 1].map((s) => (
          <path
            key={s}
            d={`M ${s * HEAD.rx * SKULL_OUT} -0.12 q ${s * 0.07} 0.02 ${s * 0.07} 0.12 t ${-s * 0.07} 0.12`}
            fill="none"
            stroke="var(--line-strong)"
            strokeWidth={0.006}
          />
        ))}
        {/* Midline */}
        <line x1="0" y1={-HEAD.ry * 0.93} x2="0" y2={HEAD.ry * 0.93} stroke="rgba(255,255,255,0.14)" strokeWidth={0.005} strokeDasharray="0.025 0.02" />
        <text x={-VIEW + 0.06} y={-VIEW + 0.12} fontSize={0.075} fontWeight={500} fill="var(--muted)" letterSpacing="0.01">L</text>
        <text x={VIEW - 0.06} y={-VIEW + 0.12} fontSize={0.075} fontWeight={500} fill="var(--muted)" textAnchor="end">R</text>

        <clipPath id="brain-clip">
          <path d={ellipsePath(SKULL_IN)} />
        </clipPath>
        {sense && (
          <circle
            clipPath="url(#brain-clip)"
            cx={sense.x * 0.94}
            cy={sense.y * 0.94}
            r={0.4}
            fill="rgba(34,195,230,0.05)"
            stroke="var(--primary)"
            strokeOpacity={0.55}
            strokeWidth={0.006}
            strokeDasharray="0.02 0.02"
          >
            <animate attributeName="stroke-dashoffset" from="0" to="-0.4" dur="3s" repeatCount="indefinite" />
          </circle>
        )}
        {spots.map((s) => (
          <Marker key={s.index} spot={s} />
        ))}
      </svg>
    </div>
  );
}
