"use client";

import { AnimatePresence, motion } from "motion/react";
import type { ScanUpdate } from "@/lib/types";
import { useDash } from "@/lib/useDash";
import { BrainView } from "./BrainView";
import { IconClock, Ring } from "./icons";
import { EASE_ENTER, EASE_EXPO, EASE_MASK, SCAN_STATUS, Swap } from "./ui";

/** Alpine Bio: one large, tightly tracked statement. */
function Verdict({ scan }: { scan: ScanUpdate | null }) {
  const s = scan ? SCAN_STATUS[scan.status] : null;
  return (
    <div className="relative h-[64px] w-[200%] overflow-hidden">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={scan?.status ?? "none"}
          initial={{ y: "100%" }}
          animate={{ y: "0%" }}
          exit={{ y: "-100%" }}
          transition={{ duration: 0.6, ease: EASE_MASK }}
          className="flex items-center gap-3"
          style={{ color: s?.color ?? "var(--muted)" }}
        >
          {s ? <s.Icon size={38} strokeWidth={1.5} /> : <IconClock size={38} strokeWidth={1.5} />}
          <span className="whitespace-nowrap text-[clamp(40px,3.9vw,56px)] font-medium leading-none tracking-[-0.05em]">
            {s?.label.replace(", re-scan", "") ?? "Awaiting scan"}
          </span>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function SpotLine({ spots, current }: { spots: { state: string; name: string; index: number }[]; current: number | null }) {
  const done = spots.filter((s) => s.state === "done").length;
  const rescan = spots.find((s) => s.state === "rescan");
  const cur = current === null ? null : spots[current];
  let text = done === 8 ? "All 8 spots scanned" : `${done} of 8 spots scanned`;
  if (cur) text = `Scanning spot ${cur.index + 1} · ${cur.name}`;
  else if (rescan) text = `Re-scan spot ${rescan.index + 1} · ${rescan.name}`;
  return (
    <div className="flex items-center gap-2.5 text-[14px] text-muted">
      <span className={cur ? "text-primary" : "text-text"}>
        <Ring progress={done / 8} size={16} />
      </span>
      <Swap value={text} />
    </div>
  );
}

/** Delta: small rounded cards clustered over the image. */
function Stat({ label, value, unit, children }: { label: string; value: string; unit?: string; children?: React.ReactNode }) {
  return (
    <div className="glass flex flex-col gap-3 rounded-[14px] p-4">
      <span className="text-[13px] text-muted">{label}</span>
      <span className="flex items-baseline gap-1">
        <Swap value={value} className="text-[30px] font-medium leading-none tracking-[-0.04em] text-text" />
        {unit && <span className="text-[14px] text-muted">{unit}</span>}
      </span>
      {children}
    </div>
  );
}

export function ScanTab() {
  const scan = useDash((s) => s.scan);
  const spots = useDash((s) => s.spots);
  const current = useDash((s) => s.currentSpot);
  const run = useDash((s) => s.run);
  const s = scan ? SCAN_STATUS[scan.status] : null;
  const conf = scan ? Math.round(scan.confidence * 100) : 0;
  const hasRegion = scan && scan.status !== "clear";

  return (
    <div className="relative h-full">
      <div className="absolute inset-y-4 right-6 left-[30%]" style={{ containerType: "size" }}>
        <div className="flex size-full items-center justify-center">
          <BrainView scan={scan} spots={spots} current={current} run={run} />
        </div>
      </div>

      <div className="pointer-events-none absolute inset-y-0 left-0 flex w-[clamp(300px,30vw,380px)] flex-col justify-between overflow-visible p-7">
        <motion.div
          initial={{ opacity: 0, y: 25 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: EASE_ENTER, delay: 0.2 }}
          className="flex flex-col gap-4"
        >
          <Verdict scan={scan} />
          <SpotLine spots={spots} current={current} />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 25 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: EASE_ENTER, delay: 0.3 }}
          className="pointer-events-auto grid grid-cols-2 gap-2.5"
        >
          <div className="col-span-2">
            <Stat label="Likely region" value={hasRegion ? scan.region : "None"} />
          </div>
          <Stat label="Volume" value={scan && scan.volume_ml > 0 ? String(scan.volume_ml) : "--"} unit="mL" />
          <Stat label="Confidence" value={scan ? String(conf) : "--"} unit="%">
            <div className="h-[3px] overflow-hidden rounded-full bg-[rgba(255,255,255,0.1)]">
              <motion.div
                className="h-full rounded-full"
                style={{ background: s?.color ?? "var(--muted)" }}
                initial={{ width: 0 }}
                animate={{ width: `${conf}%` }}
                transition={{ duration: 0.8, ease: EASE_EXPO }}
              />
            </div>
          </Stat>
        </motion.div>
      </div>
    </div>
  );
}
