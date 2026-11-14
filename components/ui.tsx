"use client";

import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import type { ScanStatus, SignalQuality } from "@/lib/types";
import { IconAlert, IconBars, IconClock, IconQuestion, IconShieldCheck, IconX } from "./icons";

export const EASE_ENTER = [0.08, 0.78, 0.56, 1] as const;
export const EASE_EXPO = [0.19, 1, 0.22, 1] as const;
export const EASE_MASK = [0.215, 0.61, 0.355, 1] as const;

// ---- Status: every status carries an icon AND a label ---------------------

export const SCAN_STATUS: Record<ScanStatus, { label: string; color: string; Icon: typeof IconAlert }> = {
  bleed: { label: "Bleed likely", color: "var(--bleed-text)", Icon: IconAlert },
  uncertain: { label: "Uncertain, re-scan", color: "var(--uncertain)", Icon: IconQuestion },
  clear: { label: "No bleed seen", color: "var(--safe-text)", Icon: IconShieldCheck },
  pending: { label: "Analyzing scan", color: "var(--muted)", Icon: IconClock },
  rejected: { label: "No result recorded", color: "var(--muted)", Icon: IconX },
};

export const QUALITY: Record<SignalQuality, { label: string; color: string; level: 1 | 2 | 3 }> = {
  good: { label: "Signal good", color: "var(--text)", level: 3 },
  weak: { label: "Signal weak", color: "var(--uncertain)", level: 2 },
  bad: { label: "No contact", color: "var(--bleed-text)", level: 1 },
};

export function QualityBadge({ quality, live }: { quality: SignalQuality; live: boolean }) {
  const q = live ? QUALITY[quality] : { label: "No signal", color: "var(--muted)", level: 1 as const };
  return (
    <span
      className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-line px-2.5 text-[12px] font-medium transition-colors duration-200"
      style={{ color: q.color }}
    >
      <IconBars level={q.level} size={14} />
      {q.label}
    </span>
  );
}

// ---- Panel ----------------------------------------------------------------

export function Panel({
  title,
  right,
  children,
  className = "",
  delay = 0,
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: EASE_ENTER, delay }}
      className={`surface flex min-h-0 flex-col ${className}`}
    >
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 px-4">
        {title ? <h2 className="label">{title}</h2> : <span />}
        <div className="flex items-center gap-2">{right}</div>
      </header>
      <div className="relative min-h-0 flex-1">{children}</div>
    </motion.section>
  );
}

// ---- Koniku mask-up swap for changing text and numbers --------------------

export function Swap({ value, className = "" }: { value: string; className?: string }) {
  return (
    <span className={`relative inline-flex overflow-hidden align-bottom ${className}`}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          initial={{ y: "100%" }}
          animate={{ y: "0%" }}
          exit={{ y: "-100%" }}
          transition={{ duration: 0.32, ease: EASE_MASK }}
          className="inline-block whitespace-nowrap"
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

// ---- Heatmap colour scale -------------------------------------------------

const HEAT = ["#39170f", "#501306", "#601b0b", "#702818", "#893826", "#b14932", "#ff5a36"].map((h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
]);

export const HEAT_CSS = "linear-gradient(to right, #39170f, #501306, #601b0b, #702818, #893826, #b14932, #ff5a36)";

/** Value 0-1 to RGB along the heat stops. */
export function heatRGB(v: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, v)) * (HEAT.length - 1);
  const i = Math.min(HEAT.length - 2, Math.floor(x));
  const f = x - i;
  const a = HEAT[i];
  const b = HEAT[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

const PANEL_RGB = [0x17, 0x19, 0x1b];

/**
 * Paint a value grid into a canvas. 0 = not scanned (transparent). Low likelihood
 * blends toward the panel colour so only real signal carries colour.
 */
export function paintGrid(canvas: HTMLCanvasElement, map: number[][]) {
  const n = map.length;
  canvas.width = n;
  canvas.height = n;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(n, n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const v = map[r][c];
      const k = (r * n + c) * 4;
      if (v <= 0) {
        img.data[k + 3] = 0;
        continue;
      }
      const [R, G, B] = heatRGB((v - 0.08) / 0.82);
      const t = Math.min(1, Math.max(0, (v - 0.08) / 0.3));
      const mix = 0.8 + 0.2 * t;
      img.data[k] = PANEL_RGB[0] + (R - PANEL_RGB[0]) * mix;
      img.data[k + 1] = PANEL_RGB[1] + (G - PANEL_RGB[1]) * mix;
      img.data[k + 2] = PANEL_RGB[2] + (B - PANEL_RGB[2]) * mix;
      img.data[k + 3] = Math.round(255 * Math.min(1, v / 0.05));
    }
  }
  ctx.putImageData(img, 0, 0);
}
