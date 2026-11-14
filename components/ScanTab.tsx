"use client";

import { AnimatePresence, motion } from "motion/react";
import type { ScanSpot, ScanUpdate } from "@/lib/types";
import { useDash } from "@/lib/useDash";
import { HeadView } from "./HeadView";
import { IconCheck, IconClock, IconInfo, IconQuestion } from "./icons";
import { EASE_EXPO, EASE_MASK, HEAT_CSS, SCAN_STATUS, Swap } from "./ui";

function Legend() {
  return (
    <div className="flex items-center gap-5 text-[12px] text-muted">
      <div className="flex items-center gap-2">
        <span>Low</span>
        <span className="h-1.5 w-28 rounded-full" style={{ background: HEAT_CSS }} />
        <span>High</span>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <span className="label">{label}</span>
      <span className="flex items-baseline gap-1.5">
        <Swap value={value} className="num-xl text-[26px] text-text" />
        {sub && <span className="text-[13px] text-muted">{sub}</span>}
      </span>
    </div>
  );
}

function ResultCard({ scan, covered }: { scan: ScanUpdate | null; covered: number }) {
  const s = scan ? SCAN_STATUS[scan.status] : null;
  const conf = scan ? Math.round(scan.confidence * 100) : 0;
  return (
    <div className="rounded-[12px] border border-line bg-raised p-4">
      <div className="relative h-[34px] overflow-hidden">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={scan?.status ?? "none"}
            initial={{ y: "100%", opacity: 0 }}
            animate={{ y: "0%", opacity: 1 }}
            exit={{ y: "-100%", opacity: 0 }}
            transition={{ duration: 0.45, ease: EASE_MASK }}
            className="flex items-center gap-2.5"
            style={{ color: s?.color ?? "var(--muted)" }}
          >
            {s ? <s.Icon size={26} strokeWidth={1.6} /> : <IconClock size={26} strokeWidth={1.6} />}
            <span className="text-[28px] font-medium leading-none tracking-[-0.03em]">{s?.label ?? "Awaiting scan"}</span>
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4">
        <Stat label="Likely region" value={scan && scan.status !== "clear" ? scan.region : "None"} />
        <Stat label="Est. volume" value={scan && scan.volume_ml > 0 ? String(scan.volume_ml) : "--"} sub="mL" />
      </div>
      <div className="mt-4 flex flex-col gap-2 border-t border-line pt-3">
        <div className="flex items-center justify-between">
          <span className="label">Confidence</span>
          <Swap value={scan ? `${conf}%` : "--"} className="text-[14px] font-medium text-text" />
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-[rgba(255,255,255,0.08)]">
          <motion.div
            className="h-full rounded-full"
            style={{ background: s?.color ?? "var(--muted)" }}
            initial={{ width: 0 }}
            animate={{ width: `${conf}%` }}
            transition={{ duration: 0.8, ease: EASE_EXPO }}
          />
        </div>
      </div>
    </div>
  );
}

const SPOT_LABEL = {
  done: { text: "Done", Icon: IconCheck, color: "var(--text)" },
  current: { text: "Scanning", Icon: null, color: "var(--primary)" },
  next: { text: "Next", Icon: IconClock, color: "var(--muted)" },
  rescan: { text: "Re-scan", Icon: IconQuestion, color: "var(--uncertain)" },
} as const;

function SpotList({ spots, nextIndex }: { spots: ScanSpot[]; nextIndex: number | null }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-[12px] border border-line bg-raised px-4 pt-4">
      <ul className="flex flex-col">
        {spots.map((s) => {
          const l = SPOT_LABEL[s.state];
          const isNext = s.state === "next" && s.index === nextIndex;
          return (
            <li key={s.index} className="flex h-9 items-center gap-3 border-t border-line text-[13px]">
              {/* Koniku 1px dash before list items */}
              <span className="h-px w-2.5 bg-line-strong" />
              <span className="w-4 text-muted">{s.index + 1}</span>
              <span className={`flex-1 ${s.state === "next" ? "text-muted" : "text-text"}`}>{s.name}</span>
              <span className="flex w-[92px] items-center gap-1.5 text-[12px] font-medium" style={{ color: isNext ? "var(--text)" : l.color }}>
                {l.Icon ? <l.Icon size={13} strokeWidth={1.7} /> : <span className="relative block size-2"><span className="pulse-ring absolute inset-0 rounded-full border border-current" /><span className="absolute inset-0 rounded-full bg-current" /></span>}
                {isNext ? "Up next" : l.text}
              </span>
              <span className="w-9 text-right text-muted">{s.peak === null ? "--" : s.peak.toFixed(2)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ScanTab() {
  const scan = useDash((s) => s.scan);
  const spots = useDash((s) => s.spots);
  const current = useDash((s) => s.currentSpot);
  const covered = spots.filter((s) => s.state === "done").length;
  const nextIndex = current === null ? (spots.find((s) => s.state === "next")?.index ?? null) : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 gap-6 px-5 pt-4">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex justify-end">
            <Legend />
          </div>
          <div className="my-2 flex min-h-0 flex-1 items-center justify-center" style={{ containerType: "size" }}>
            <HeadView scan={scan} spots={spots} current={current} />
          </div>
        </div>
        <div className="flex w-[330px] shrink-0 flex-col gap-5">
          <ResultCard scan={scan} covered={covered} />
          <SpotList spots={spots} nextIndex={nextIndex} />
        </div>
      </div>
    </div>
  );
}
