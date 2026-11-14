"use client";

import { motion } from "motion/react";
import { DEMO_LENGTH_MS, PATIENT_ID, PRODUCT_NAME } from "@/lib/config";
import { demo } from "@/lib/demo";
import type { DeviceStatus } from "@/lib/types";
import { formatClock, useDash } from "@/lib/useDash";
import { IconArrowRight, IconPause, IconPlay, IconPlug, Spinner, Wave } from "./icons";
import { EASE_ENTER, Swap } from "./ui";

const DEVICE: Record<DeviceStatus, { label: string; color: string }> = {
  disconnected: { label: "Disconnected", color: "var(--muted)" },
  connecting: { label: "Connecting", color: "var(--muted)" },
  connected: { label: "Device connected", color: "var(--primary)" },
  scanning: { label: "Scanning", color: "var(--primary)" },
};

function DevicePill() {
  const device = useDash((s) => s.device);
  const d = DEVICE[device];
  return (
    <span
      className="inline-flex h-8 items-center gap-2 rounded-full border border-line bg-raised pl-2.5 pr-3 text-[13px] font-medium transition-colors duration-300"
      style={{ color: d.color }}
    >
      <span className="grid size-4 place-items-center">
        {device === "disconnected" && <IconPlug size={14} />}
        {device === "connecting" && <Spinner size={13} />}
        {device === "connected" && (
          <span className="relative block size-2">
            <span className="pulse-ring absolute inset-0 rounded-full border border-current" />
            <span className="absolute inset-0 rounded-full bg-current" />
          </span>
        )}
        {device === "scanning" && <Wave height={11} />}
      </span>
      <Swap value={d.label} />
    </span>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="label">{label}</span>
      <span className="text-[14px] font-medium leading-none text-text">{value}</span>
    </div>
  );
}

function Elapsed() {
  const ms = useDash((s) =>
    s.scanStartedAt === null ? null : Math.floor(((s.scanEndedAt ?? s.t) - s.scanStartedAt) / 1000),
  );
  return <Meta label="Scan time" value={ms === null ? "--:--" : formatClock(ms * 1000)} />;
}

/** Alpine Bio split pill (label + arrow circle) with Delta's arrow-swap hover. */
function DemoControl() {
  const playing = useDash((s) => s.playing);
  const sec = useDash((s) => Math.floor(s.t / 1000));
  const progress = (sec * 1000) / DEMO_LENGTH_MS;
  return (
    <div className="flex items-center gap-2">
      <div className="flex flex-col items-end gap-1.5">
        <span className="label">Demo</span>
        <span className="text-[13px] font-medium leading-none text-muted">
          {formatClock(sec * 1000)} / {formatClock(DEMO_LENGTH_MS)}
        </span>
      </div>
      <button
        type="button"
        onClick={() => demo.togglePause()}
        aria-label={playing ? "Pause demo" : "Resume demo"}
        className="grid size-11 place-items-center rounded-full border border-line text-muted transition-colors duration-200 [transition-timing-function:var(--ease-hover)] hover:border-line-strong hover:text-text"
      >
        {playing ? <IconPause size={14} /> : <IconPlay size={14} />}
      </button>
      <button
        type="button"
        onClick={() => demo.restart()}
        className="group relative flex h-11 items-center gap-1 overflow-hidden rounded-full border border-line bg-raised pl-4 pr-1 text-[14px] font-medium text-text transition-colors duration-200 [transition-timing-function:var(--ease-hover)] hover:border-line-strong"
      >
        <span>Play demo</span>
        <span className="relative grid size-9 place-items-center overflow-hidden rounded-full bg-text text-bg">
          <span className="absolute transition-transform duration-[400ms] [transition-timing-function:var(--ease-swap)] group-hover:translate-x-[calc(100%+12px)]">
            <IconArrowRight size={14} />
          </span>
          <span className="absolute -translate-x-[calc(100%+12px)] transition-transform duration-[400ms] [transition-timing-function:var(--ease-swap)] group-hover:translate-x-0">
            <IconArrowRight size={14} />
          </span>
        </span>
        <span
          className="absolute bottom-0 left-0 h-px bg-primary"
          style={{ width: `${progress * 100}%`, transition: "width 1s linear" }}
        />
      </button>
    </div>
  );
}

export function Header() {
  return (
    <motion.header
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: EASE_ENTER }}
      className="flex h-14 shrink-0 items-center justify-between"
    >
      <div className="flex items-center gap-5">
        <div className="flex items-center gap-2.5">
          <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
            <circle cx="11" cy="11" r="9.5" fill="none" stroke="var(--text)" strokeWidth="1.2" />
            <path d="M11 1.5a9.5 9.5 0 0 1 0 19" fill="none" stroke="var(--primary)" strokeWidth="1.2" />
            <circle cx="11" cy="11" r="2.2" fill="var(--text)" />
          </svg>
          <span className="text-[20px] font-semibold tracking-[-0.03em]">{PRODUCT_NAME}</span>
        </div>
        <span className="h-6 w-px bg-line" />
        <DevicePill />
      </div>
      <div className="flex items-center gap-8">
        <Meta label="Patient" value={PATIENT_ID} />
        <Elapsed />
        <span className="h-8 w-px bg-line" />
        <DemoControl />
      </div>
    </motion.header>
  );
}
