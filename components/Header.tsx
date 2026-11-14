"use client";

import { motion } from "motion/react";
import { DEMO_LENGTH_MS } from "@/lib/config";
import { demo } from "@/lib/demo";
import type { DeviceStatus } from "@/lib/types";
import { formatClock, useDash } from "@/lib/useDash";
import { IconArrowRight, IconClock, IconLink, IconPause, IconPlay, IconPlug, Spinner } from "./icons";
import { Logo } from "./Logo";
import { EASE_ENTER, Swap } from "./ui";

const DEVICE: Record<DeviceStatus, { label: string; color: string }> = {
  disconnected: { label: "Disconnected", color: "var(--muted)" },
  connecting: { label: "Connecting", color: "var(--muted)" },
  connected: { label: "Device connected", color: "var(--primary)" },
  scanning: { label: "Scanning", color: "var(--primary)" },
};

function DeviceStatusChip() {
  const device = useDash((s) => s.device);
  const d = DEVICE[device];
  return (
    <span className="inline-flex items-center gap-2 text-[14px] font-medium transition-colors duration-300" style={{ color: d.color }}>
      <span className="grid size-4 place-items-center">
        {device === "disconnected" && <IconPlug size={14} />}
        {(device === "connecting" || device === "scanning") && <Spinner size={13} />}
        {device === "connected" && <IconLink size={15} />}
      </span>
      <Swap value={d.label} />
    </span>
  );
}

function Elapsed() {
  const sec = useDash((s) =>
    s.scanStartedAt === null ? null : Math.floor(((s.scanEndedAt ?? s.t) - s.scanStartedAt) / 1000),
  );
  return (
    <span className="flex items-center gap-1.5 text-[14px] text-text" title="Scan time">
      <IconClock size={14} className="text-muted" />
      {sec === null ? "--:--" : formatClock(sec * 1000)}
    </span>
  );
}

/** Delta / GenRevive: filled pill CTA with a contrasting circular end, arrow swaps on hover. */
function PlayDemo() {
  const sec = useDash((s) => Math.floor(s.t / 1000));
  const progress = (sec * 1000) / DEMO_LENGTH_MS;
  return (
    <button
      type="button"
      onClick={() => demo.restart()}
      className="group relative flex h-11 items-center gap-3 overflow-hidden rounded-full bg-text pl-5 pr-1 text-[14px] font-medium text-bg transition-transform duration-150 active:scale-[0.97]"
    >
      <span className="flex flex-col items-start leading-none">
        <span>Play demo</span>
      </span>
      <span className="relative grid size-9 place-items-center overflow-hidden rounded-full bg-bg text-text">
        <span className="absolute transition-transform duration-[400ms] [transition-timing-function:var(--ease-swap)] group-hover:translate-x-[calc(100%+12px)]">
          <IconArrowRight size={14} />
        </span>
        <span className="absolute -translate-x-[calc(100%+12px)] transition-transform duration-[400ms] [transition-timing-function:var(--ease-swap)] group-hover:translate-x-0">
          <IconArrowRight size={14} />
        </span>
      </span>
      <span className="absolute bottom-0 left-0 h-[2px] bg-primary" style={{ width: `${progress * 100}%`, transition: "width 1s linear" }} />
    </button>
  );
}

export function Header() {
  const playing = useDash((s) => s.playing);
  const sec = useDash((s) => Math.floor(s.t / 1000));
  return (
    <motion.header
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: EASE_ENTER }}
      className="relative z-20 flex h-14 shrink-0 items-center gap-3"
    >
      {/* Delta: one long translucent nav pill. */}
      <div className="glass raised flex h-14 flex-1 items-center gap-6 rounded-full pl-5 pr-2">
        <Logo />
        <span className="h-5 w-px bg-line" />
        <DeviceStatusChip />
        <div className="ml-auto flex items-center gap-5">
          <Elapsed />
          <span className="h-5 w-px bg-line" />
          <span className="text-[13px] text-muted">
            {formatClock(sec * 1000)} / {formatClock(DEMO_LENGTH_MS)}
          </span>
          <button
            type="button"
            onClick={() => demo.togglePause()}
            aria-label={playing ? "Pause demo" : "Resume demo"}
            className="grid size-10 place-items-center rounded-full text-muted transition-colors duration-150 hover:bg-raised hover:text-text"
          >
            {playing ? <IconPause size={14} /> : <IconPlay size={14} />}
          </button>
        </div>
      </div>
      <PlayDemo />
    </motion.header>
  );
}
