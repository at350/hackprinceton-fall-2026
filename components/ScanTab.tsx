"use client";

import { AnimatePresence, motion } from "motion/react";
import type { ScanSpot, ScanUpdate } from "@/lib/types";
import { useDash } from "@/lib/useDash";
import { BrainView } from "./BrainView";
import { IconClock, Ring } from "./icons";
import { EASE_ENTER, EASE_MASK, SCAN_STATUS } from "./ui";

/** Primary: one large, tightly tracked statement (Alpine Bio). */
function Verdict({ scan }: { scan: ScanUpdate | null }) {
  const s = scan ? SCAN_STATUS[scan.status] : null;
  return (
    // Clip vertically only (for the mask-up swap) so the text is never cut horizontally.
    <div className="relative h-[60px] w-full" style={{ overflowX: "visible", overflowY: "clip" }}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.h1
          key={scan?.status ?? "none"}
          initial={{ y: "135%" }}
          animate={{ y: "0%" }}
          exit={{ y: "-135%" }}
          transition={{ duration: 0.6, ease: EASE_MASK }}
          className="flex items-center gap-3"
          style={{ color: s?.color ?? "var(--muted)" }}
        >
          {s ? <s.Icon size={36} strokeWidth={1.5} /> : <IconClock size={36} strokeWidth={1.5} />}
          <span className="font-display whitespace-nowrap text-[clamp(40px,3.9vw,56px)] font-medium leading-none tracking-[-0.045em]">
            {s?.label ?? "Awaiting scan"}
          </span>
        </motion.h1>
      </AnimatePresence>
    </div>
  );
}

/** Secondary: the numbers behind the verdict, as one line directly under it. */
function Summary({ scan, done }: { scan: ScanUpdate | null; done: number }) {
  const parts: string[] = !scan
    ? ["Place the device on spot 1 to begin"]
    : scan.status === "pending"
      ? ["Result appears once you approve it"]
      : scan.status === "rejected"
        ? ["You rejected the proposed result"]
      : scan.status === "clear"
      ? [`Nothing in ${done} of 8 spots`, `${Math.round(scan.confidence * 100)}% confidence`]
      : [
          scan.region,
          ...(scan.volume_ml > 0 ? [`${scan.volume_ml} mL`] : []),
          `${Math.round(scan.confidence * 100)}% confidence`,
        ];
  const key = parts.join("|");
  return (
    <div className="relative h-7 w-full" style={{ overflowX: "visible", overflowY: "clip" }}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.p
          key={key}
          initial={{ y: "135%", opacity: 0 }}
          animate={{ y: "0%", opacity: 1 }}
          exit={{ y: "-135%", opacity: 0 }}
          transition={{ duration: 0.32, ease: EASE_MASK }}
          className="flex items-center gap-2.5 whitespace-nowrap text-[20px] leading-7 tracking-[-0.02em]"
        >
          {parts.map((p, i) => (
            <span key={i} className="flex items-center gap-2.5">
              {i > 0 && <span className="size-1 rounded-full bg-muted opacity-50" />}
              <span className={scan && scan.status !== "pending" && scan.status !== "rejected" ? "text-text" : "text-muted"}>{p}</span>
            </span>
          ))}
        </motion.p>
      </AnimatePresence>
    </div>
  );
}

/** Tertiary: scan progress, quiet, top right. */
function Progress({ spots, current }: { spots: ScanSpot[]; current: number | null }) {
  const done = spots.filter((s) => s.state === "done").length;
  const rescan = spots.find((s) => s.state === "rescan");
  const cur = current === null ? null : spots[current];
  const text = cur ? `Spot ${cur.index + 1} · ${cur.name}` : rescan ? `Re-scan spot ${rescan.index + 1}` : `${done} of 8 spots`;
  return (
    <div className="flex shrink-0 items-center gap-2.5 pt-2 text-[14px] text-muted">
      <span className={cur ? "text-primary" : rescan ? "text-uncertain" : "text-text"}>
        <Ring progress={done / 8} size={16} />
      </span>
      <span className="whitespace-nowrap">{text}</span>
    </div>
  );
}

export function ScanTab() {
  const scan = useDash((s) => s.scan);
  const spots = useDash((s) => s.spots);
  const current = useDash((s) => s.currentSpot);
  const run = useDash((s) => s.run);
  const done = spots.filter((s) => s.state === "done").length;

  return (
    <div className="flex h-full flex-col px-7 pt-6 pb-4">
      <motion.header
        initial={{ opacity: 0, y: 25 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: EASE_ENTER, delay: 0.2 }}
        className="flex shrink-0 items-start justify-between gap-6"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <Verdict scan={scan} />
          <Summary scan={scan} done={done} />
        </div>
        <Progress spots={spots} current={current} />
      </motion.header>

      <div className="mt-2 min-h-0 flex-1" style={{ containerType: "size" }}>
        <div className="flex size-full items-center justify-center">
          <BrainView scan={scan} spots={spots} current={current} run={run} />
        </div>
      </div>
    </div>
  );
}
