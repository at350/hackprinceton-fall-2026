"use client";

import { motion } from "motion/react";
import { demo } from "@/lib/demo";
import type { TabId } from "@/lib/types";
import { useDash } from "@/lib/useDash";
import { ScanTab } from "./ScanTab";
import { SimulationsTab } from "./SimulationsTab";
import { EASE_ENTER, EASE_EXPO } from "./ui";

function TabButton({ id, label, count, active }: { id: TabId; label: string; count: string; active: boolean }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => demo.setTab(id)}
      className={`relative flex h-11 min-w-[168px] items-center justify-between gap-6 px-4 text-[14px] font-medium transition-colors duration-200 [transition-timing-function:var(--ease-hover)] ${
        active ? "text-text" : "text-muted hover:text-text"
      }`}
    >
      {/* Folder tab from the sketch; slides between tabs. */}
      {active && (
        <motion.span
          layoutId="folder-tab"
          transition={{ duration: 0.5, ease: EASE_EXPO }}
          className="absolute inset-0 -bottom-px rounded-t-[12px] border border-b-0 border-line bg-panel"
        />
      )}
      <span className="relative">{label}</span>
      <span className="relative text-[12px] text-muted">{count}</span>
    </button>
  );
}

export function LeftPanel() {
  const tab = useDash((s) => s.tab);
  const spotsDone = useDash((s) => s.spots.filter((p) => p.state === "done").length);
  const simsDone = useDash((s) => s.sims.filter((p) => p.status === "done").length);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: EASE_ENTER, delay: 0.05 }}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div role="tablist" className="relative z-10 flex">
        <TabButton id="scan" label="Scan" count={`${spotsDone}/8`} active={tab === "scan"} />
        <TabButton id="simulations" label="Simulations" count={`${simsDone}/24`} active={tab === "simulations"} />
      </div>
      <div className="surface relative min-h-0 flex-1 overflow-hidden rounded-tl-none">
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
