"use client";

import { motion } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";
import { demo } from "@/lib/demo";
import type { TabId } from "@/lib/types";
import { useDash } from "@/lib/useDash";
import { ScanTab } from "./ScanTab";
import { SimulationsTab } from "./SimulationsTab";
import { EASE_ENTER } from "./ui";

const TAB_H = 44;
const TAB_R = 12; // tab's top corners
const FILLET = 10; // concave curve where the tab meets the panel
const PANEL_R = 14;

/**
 * Folder outline: the active tab and the panel as one continuous shape, so
 * there is a single border and no seam where they meet.
 */
function folderPath(W: number, H: number, x0: number, x1: number) {
  const t = TAB_H, r = TAB_R, f = FILLET, R = PANEL_R;
  // Left edge up to the tab: straight up the tab's side when it is the first tab,
  // otherwise the panel's top-left corner, along the top, and a fillet into the tab.
  const left =
    x0 <= 0.5
      ? `M 0 ${H - R} L 0 ${r}`
      : `M 0 ${H - R} L 0 ${t + R} A ${R} ${R} 0 0 1 ${R} ${t} L ${x0 - f} ${t} A ${f} ${f} 0 0 0 ${x0} ${t - f} L ${x0} ${r}`;
  const tabTop = `A ${r} ${r} 0 0 1 ${x0 + r} 0 L ${x1 - r} 0 A ${r} ${r} 0 0 1 ${x1} ${r} L ${x1} ${t - f} A ${f} ${f} 0 0 0 ${x1 + f} ${t}`;
  const right = `L ${W - R} ${t} A ${R} ${R} 0 0 1 ${W} ${t + R} L ${W} ${H - R} A ${R} ${R} 0 0 1 ${W - R} ${H} L ${R} ${H} A ${R} ${R} 0 0 1 0 ${H - R}`;
  return `${left} ${tabTop} ${right} Z`;
}

function TabButton({
  id,
  label,
  count,
  active,
  onRef,
}: {
  id: TabId;
  label: string;
  count: string;
  active: boolean;
  onRef: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      ref={onRef}
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => demo.setTab(id)}
      className={`relative flex min-w-[168px] items-center justify-between gap-6 px-4 text-[14px] font-medium transition-colors duration-200 [transition-timing-function:var(--ease-hover)] ${
        active ? "text-text" : "text-muted hover:text-text"
      }`}
      style={{ height: TAB_H }}
    >
      <span>{label}</span>
      <span className="text-[12px] text-muted">{count}</span>
    </button>
  );
}

export function LeftPanel() {
  const tab = useDash((s) => s.tab);
  const spotsDone = useDash((s) => s.spots.filter((p) => p.state === "done").length);
  const simsDone = useDash((s) => s.sims.filter((p) => p.status === "done").length);
  const simsTotal = useDash((s) => s.sims.length);
  const host = useRef<HTMLDivElement>(null);
  const tabs = useRef<Record<TabId, HTMLButtonElement | null>>({ scan: null, simulations: null });
  const [d, setD] = useState("");

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => {
      const btn = tabs.current[tab];
      if (!btn) return;
      setD(folderPath(el.clientWidth, el.clientHeight, btn.offsetLeft, btn.offsetLeft + btn.offsetWidth));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab]);

  return (
    <motion.div
      ref={host}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: EASE_ENTER, delay: 0.05 }}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {/* One shape for tab + panel: glass fill clipped to the outline, grain, then a single hairline. */}
      {d && (
        <>
          <div
            className="folder-fill pointer-events-none absolute inset-0"
            style={{ clipPath: `path("${d}")`, transition: "clip-path 450ms cubic-bezier(0.19,1,0.22,1)" }}
          />
          <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden>
            <path d={d} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={1} style={{ transition: "d 450ms cubic-bezier(0.19,1,0.22,1)" }} />
          </svg>
        </>
      )}
      <div role="tablist" className="relative z-10 flex">
        <TabButton id="scan" label="Scan" count={`${spotsDone}/8`} active={tab === "scan"} onRef={(el) => (tabs.current.scan = el)} />
        <TabButton
          id="simulations"
          label="Simulations"
          count={`${simsDone}/${simsTotal}`}
          active={tab === "simulations"}
          onRef={(el) => (tabs.current.simulations = el)}
        />
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-b-[14px]">
        {(["scan", "simulations"] as const).map((id) => (
          <motion.div
            key={id}
            role="tabpanel"
            aria-hidden={tab !== id}
            initial={false}
            animate={{ opacity: tab === id ? 1 : 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0"
            style={{ pointerEvents: tab === id ? "auto" : "none", visibility: tab === id ? "visible" : "hidden" }}
          >
            {id === "scan" ? <ScanTab /> : <SimulationsTab />}
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
}
