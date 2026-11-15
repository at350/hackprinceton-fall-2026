"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { devicePresence } from "@/lib/device";
import { SCAN_CASES, type ScanCase, live } from "@/lib/live";
import { MODES, modeDef, setMode, useMode } from "@/lib/mode";
import { store } from "@/lib/store";
import type { DeviceStatus, ViewId } from "@/lib/types";
import { formatClock, useDash } from "@/lib/useDash";
import { IconArrowRight, IconCheck, IconChevronDown, IconClock, IconDashboard, IconLink, IconPlug, IconWorkflow, Spinner } from "./icons";
import { Logo } from "./Logo";
import { EASE_ENTER, Swap } from "./ui";

// Beautiful UI motion.
const EASE_UI = [0.23, 1, 0.32, 1] as const;

const DEVICE: Record<DeviceStatus, { label: string; color: string }> = {
  disconnected: { label: "No device", color: "var(--muted)" },
  connecting: { label: "Connecting", color: "var(--muted)" },
  // The mode under it names the device.
  connected: { label: "Connected", color: "var(--primary)" },
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
    <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[14px] text-text" title="Scan time">
      <IconClock size={14} className="text-muted" />
      {sec === null ? "--:--" : formatClock(sec * 1000)}
    </span>
  );
}

/** Delta / GenRevive: filled pill CTA with a contrasting circular end, arrow swaps on hover. Disabled, it says why on hover. */
function Cta({ label, onClick, disabled, reason }: { label: string; onClick: () => void; disabled?: boolean; reason?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? reason : undefined}
      className="group relative flex h-11 items-center gap-3 overflow-hidden rounded-full bg-text pl-5 pr-1 text-[14px] font-medium text-bg transition-[transform,opacity] duration-150 enabled:active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-35"
    >
      <span className="flex flex-col items-start leading-none">
        <span>{label}</span>
      </span>
      <span className="relative grid size-9 place-items-center overflow-hidden rounded-full bg-bg text-text">
        <span className="absolute transition-transform duration-[400ms] [transition-timing-function:var(--ease-swap)] group-enabled:group-hover:translate-x-[calc(100%+12px)]">
          <IconArrowRight size={14} />
        </span>
        <span className="absolute -translate-x-[calc(100%+12px)] transition-transform duration-[400ms] [transition-timing-function:var(--ease-swap)] group-enabled:group-hover:translate-x-0">
          <IconArrowRight size={14} />
        </span>
      </span>
    </button>
  );
}

/**
 * Which device feeds the dashboard (lib/mode.ts), named under the device status.
 * The menu gives each mode's one line; switching starts the dashboard over.
 */
function ModeMenu() {
  const mode = useMode();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => void (root.current?.contains(e.target as Node) || setOpen(false));
    const esc = (e: KeyboardEvent) => void (e.key === "Escape" && setOpen(false));
    addEventListener("pointerdown", away);
    addEventListener("keydown", esc);
    return () => {
      removeEventListener("pointerdown", away);
      removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 whitespace-nowrap text-[12.5px] leading-none transition-colors duration-150 hover:text-text ${open ? "text-text" : "text-muted"}`}
      >
        {modeDef(mode).label}
        <IconChevronDown size={11} className="transition-transform duration-300" style={{ transform: open ? "rotate(180deg)" : "none" }} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            aria-label="Mode"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2, ease: EASE_UI }}
            className="absolute top-[calc(100%+14px)] -left-3 w-[288px] rounded-[14px] border border-[rgba(255,255,255,0.08)] bg-[#181b20] p-1.5"
          >
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="menuitemradio"
                aria-checked={m.id === mode}
                onClick={() => {
                  setMode(m.id);
                  setOpen(false);
                }}
                className="flex w-full items-start gap-2.5 rounded-[10px] px-2.5 py-2.5 text-left transition-colors duration-100 hover:bg-[rgba(255,255,255,0.05)]"
              >
                <span className="grid h-[18px] w-4 shrink-0 place-items-center text-primary">{m.id === mode && <IconCheck size={14} />}</span>
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="text-[13.5px] font-medium leading-[18px] text-text">{m.label}</span>
                  <span className="text-[12.5px] leading-[1.45] text-muted">{m.description}</span>
                </span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Which mock scan the simulated device holds. Same segmented look as the view switch. */
function ScanPicker({ value, onChange }: { value: ScanCase; onChange: (id: ScanCase) => void }) {
  const segment = "h-8 items-center whitespace-nowrap rounded-[7px] px-3 text-[13px] font-medium transition-colors duration-150";
  const at = SCAN_CASES.findIndex((c) => c.id === value);
  return (
    <div role="radiogroup" aria-label="Mock scan" className="flex shrink-0 gap-0.5 rounded-[10px] bg-[rgba(0,0,0,0.3)] p-1">
      {SCAN_CASES.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          onClick={() => onChange(id)}
          className={`hidden @min-[1100px]:flex ${segment} ${value === id ? "bg-[rgba(255,255,255,0.12)] text-text" : "text-muted hover:text-text"}`}
        >
          {label}
        </button>
      ))}
      {/* Narrow bar: one segment that steps through the cases. */}
      <button
        type="button"
        title="Mock scan"
        onClick={() => onChange(SCAN_CASES[(at + 1) % SCAN_CASES.length].id)}
        className={`flex @min-[1100px]:hidden ${segment} bg-[rgba(255,255,255,0.12)] text-text`}
      >
        {SCAN_CASES[at].label}
      </button>
    </div>
  );
}

/** n8n's top-center Editor / Executions switch, here Dashboard / Agent trace. */
function ViewSwitch() {
  const view = useDash((s) => s.view);
  const items: { id: ViewId; label: string; Icon: typeof IconDashboard }[] = [
    { id: "dashboard", label: "Dashboard", Icon: IconDashboard },
    { id: "trace", label: "Agent trace", Icon: IconWorkflow },
  ];
  return (
    <div role="tablist" className="flex gap-0.5 rounded-[10px] bg-[rgba(0,0,0,0.3)] p-1">
      {items.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={view === id}
          onClick={() => store.setView(id)}
          aria-label={label}
          title={label}
          className={`flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[7px] px-3 text-[13px] font-medium transition-colors duration-150 ${
            view === id ? "bg-[rgba(255,255,255,0.12)] text-text" : "text-muted hover:text-text"
          }`}
        >
          <Icon size={15} />
          {/* Icons only on narrow screens. */}
          <span className="hidden @min-[760px]:inline">{label}</span>
        </button>
      ))}
    </div>
  );
}

export function Header() {
  const mode = useMode();
  useDash((s) => s.device); // re-render when the device bridge's answer changes
  const device = devicePresence(mode);
  const [scanCase, setScanCase] = useState<ScanCase>("temporal_bleed");
  return (
    <motion.header
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: EASE_ENTER }}
      className="relative z-20 flex h-14 shrink-0 items-center gap-3"
    >
      {/* Delta: one long translucent nav pill. */}
      {/* Equal-weight sides keep the switch centred; the bar's own width decides what fits. */}
      <div className="@container glass raised flex h-14 min-w-0 flex-1 items-center gap-4 rounded-full pl-5 pr-2">
        <div className="flex min-w-0 flex-1 basis-0 items-center gap-5">
          <Logo />
          <span className="h-5 w-px shrink-0 bg-line" />
          {/* The device: its status, and under it the mode that says which device. */}
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="min-w-0 truncate">
              <DeviceStatusChip />
            </span>
            <span className="pl-6">
              <ModeMenu />
            </span>
          </div>
        </div>
        <ViewSwitch />
        <div className="flex min-w-0 flex-1 basis-0 items-center justify-end gap-5">
          <Elapsed />
          {modeDef(mode).source === "mock" && <ScanPicker value={scanCase} onChange={setScanCase} />}
        </div>
      </div>
      <Cta label="Run scan" onClick={() => live.restart(scanCase)} disabled={!device.connected} reason={device.reason} />
    </motion.header>
  );
}
