"use client";

import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { drawDimBrain, loadBrain, renderScanned } from "@/lib/brain";
import { demo } from "@/lib/demo";
import { pointAt } from "@/lib/mock";
import type { TraceFold, TraceHero, TraceLog, TraceNode, TracePanel, TracePlanStep } from "@/lib/trace";
import { deriveTrace } from "@/lib/trace";
import { formatClock, useDash } from "@/lib/useDash";
import { IconCheck, IconChevronDown, IconClock, IconPause, IconTool, IconX } from "./icons";
import { NODE_ICON, TraceCanvas } from "./TraceCanvas";
import { EASE_ENTER, SCAN_STATUS, heatRGB } from "./ui";

// The node details panel: a header, one big thing, one sentence, and at most one
// fold. No times, no field lists; the empty space below is intended.

/** The plan's current step: a ring with a dot (as in the agent panel), never animated. */
function Current({ size = 14 }: { size?: number }) {
  return (
    <span className="grid shrink-0 place-items-center rounded-full border-[1.5px] border-current" style={{ width: size, height: size }}>
      <span className="size-[5px] rounded-full bg-current" />
    </span>
  );
}

const STATUS: Record<TraceNode["status"], { label: string; color: string; icon: ReactNode }> = {
  idle: { label: "Not run", color: "var(--muted)", icon: <IconClock size={13} /> },
  running: { label: "Running", color: "var(--primary)", icon: <Current size={13} /> },
  waiting: { label: "Waiting for medic", color: "var(--primary)", icon: <IconPause size={13} /> },
  success: { label: "Success", color: "var(--primary)", icon: <IconCheck size={13} /> },
  error: { label: "Rejected", color: "var(--bleed-text)", icon: <IconX size={13} /> },
};

const TONE = { primary: "var(--primary)", bleed: "var(--bleed-text)" };
const BIG = "font-display text-[42px] font-medium leading-[1.04] tracking-[-0.045em]";

/** The brain render with one hypothesis's heat, as on the simulation cards. */
function BrainThumb({ map, size }: { map: number[][]; size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    loadBrain().then(() => setLoaded(true));
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const c = ref.current!;
    const px = Math.round(size * devicePixelRatio);
    c.width = c.height = px;
    const ctx = c.getContext("2d")!;
    drawDimBrain(ctx, px, 0.3);
    ctx.drawImage(renderScanned(map, px, false), 0, 0);
  }, [loaded, map, size]);
  return <canvas ref={ref} className="shrink-0" style={{ width: size, height: size }} aria-hidden />;
}

// The spot ring: 330 × 184 px, map space scaled by K, spot marks just outside the brain.
const RING = { w: 330, h: 184, k: 78, r: 1.16 };
const heatHex = (v: number) => `rgb(${heatRGB(v).map(Math.round).join(",")})`;

/** The scan on the brain with the 8 spots around it; only the highest reading and a weak spot are labelled. */
function SpotRing({ hero }: { hero: Extract<TraceHero, { kind: "spots" }> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    loadBrain().then(() => setLoaded(true));
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const c = ref.current!;
    const px = Math.round(c.clientWidth * devicePixelRatio);
    c.width = c.height = px;
    const ctx = c.getContext("2d")!;
    drawDimBrain(ctx, px, 0.14);
    if (hero.map) ctx.drawImage(renderScanned(hero.map, px), 0, 0);
  }, [loaded, hero.map]);

  const { w, h, k } = RING;
  const side = (2 * k) / w;
  const highest = hero.spots.reduce<(typeof hero.spots)[number] | null>((a, p) => (p.peak !== null && (!a || p.peak > a.peak!) ? p : a), null);
  return (
    <div className="relative w-full" style={{ aspectRatio: `${w} / ${h}` }}>
      <canvas
        ref={ref}
        className="absolute"
        style={{ left: `${((1 - side) / 2) * 100}%`, top: `${((h - 2 * k) / 2 / h) * 100}%`, width: `${side * 100}%`, height: `${((2 * k) / h) * 100}%` }}
        aria-hidden
      />
      <svg viewBox={`${-w / 2} ${-h / 2} ${w} ${h}`} className="absolute inset-0 size-full" role="img" aria-label="Peak reading at each of the 8 scan spots, seen from above, patient's left on the left">
        {hero.spots.map((p) => {
          const at = pointAt(p.angle, RING.r);
          const x = at.x * k;
          const y = at.y * k;
          const left = x < -1;
          const isWeak = hero.weak.includes(p.index);
          const fill = p.peak !== null ? heatHex((p.peak - 0.1) / 0.8) : hero.current === p.index ? "var(--primary)" : "rgba(20,23,28,0.85)";
          const stroke = isWeak ? "var(--uncertain)" : `rgba(255,255,255,${p.peak !== null && p.peak > 0.5 ? 0.55 : 0.3})`;
          return (
            <g key={p.index}>
              <circle cx={x} cy={y} r={5.5} fill={fill} stroke={stroke} />
              {p === highest && (
                <text x={left ? x - 12 : x + 12} y={y + 4} fontSize={12} textAnchor={left ? "end" : "start"} fill="var(--text)">
                  {p.name} <tspan fill={p.peak! > 0.5 ? "var(--bleed-text)" : "var(--muted)"}>{p.peak!.toFixed(2)}</tspan>
                </text>
              )}
              {isWeak && p !== highest && (
                <text x={left ? x - 10 : x + 10} y={y + 13} fontSize={11} textAnchor={left ? "end" : "start"} fill="var(--uncertain)">
                  {p.state === "rescan" ? "re-scan" : "weak contact"}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <span className="label">{label}</span>
      <p className={`${BIG} whitespace-nowrap text-text`}>{value}</p>
    </div>
  );
}

function Hero({ hero }: { hero: TraceHero }) {
  switch (hero.kind) {
    case "verdict": {
      const v = SCAN_STATUS[hero.status];
      return (
        <p className={`flex items-start gap-3 ${BIG}`} style={{ color: v.color }}>
          <v.Icon size={30} className="mt-[6px] shrink-0" />
          <span>{v.label}</span>
        </p>
      );
    }
    case "statement":
      if (hero.size === "question") return <p className="font-display text-[27px] font-medium leading-[1.12] tracking-[-0.035em] text-text">{hero.text}</p>;
      return (
        <p className={`flex items-start gap-3 ${BIG}`} style={{ color: hero.tone ? TONE[hero.tone] : "var(--text)" }}>
          {hero.icon === "check" && <IconCheck size={30} className="mt-[6px] shrink-0" />}
          {hero.icon === "x" && <IconX size={30} className="mt-[6px] shrink-0" />}
          <span>{hero.text}</span>
        </p>
      );
    case "number":
      return <Figure label={hero.label} value={hero.value} />;
    case "fit":
      return (
        <div className="flex items-center gap-[22px]">
          <BrainThumb map={hero.map} size={96} />
          <Figure label={hero.label} value={hero.value} />
        </div>
      );
    case "spots":
      return <SpotRing hero={hero} />;
  }
}

/** beautifului.dev Thinking row: chevron, label, count on the right; opens in place. */
function Fold({ fold, children }: { fold: TraceFold; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-y border-line">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex h-11 w-full items-center gap-2 text-left text-[13.5px] text-text">
        <IconChevronDown
          size={12}
          className="shrink-0 text-muted transition-transform duration-200"
          style={{ transform: open ? "none" : "rotate(-90deg)", transitionTimingFunction: "var(--ease-hover)" }}
        />
        <span>{fold.title}</span>
        <span className="ml-auto text-[12.5px] text-muted">{fold.count}</span>
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-300"
        style={{ gridTemplateRows: open ? "1fr" : "0fr", transitionTimingFunction: "var(--ease-hover)" }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col pb-4 pl-5">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** beautifului.dev Task Rows (List): check, current or pending, with the step's tool calls as verb plus mono argument. */
function PlanStep({ step, waiting }: { step: TracePlanStep; waiting: boolean }) {
  return (
    <>
      <div className={`flex min-h-8 items-center gap-2.5 text-[13px] ${step.state === "pending" ? "text-muted" : "text-text"}`}>
        <span className="flex w-4 shrink-0 justify-center text-primary">
          {step.state === "done" ? (
            <IconCheck size={14} />
          ) : step.state === "running" ? (
            waiting ? <IconPause size={14} /> : <Current />
          ) : (
            <span className="size-[13px] rounded-full border border-[rgba(255,255,255,0.22)]" />
          )}
        </span>
        <span>{step.label}</span>
      </div>
      {step.tools.map((x) => (
        <div key={x.id} className={`flex min-h-7 items-center gap-2.5 pl-[26px] text-[13px] ${x.running ? "text-text" : "text-muted"}`}>
          <IconTool size={13} className="shrink-0 text-muted" />
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span>{x.label}</span>
            {x.detail && <span className="font-mono text-[11.5px] text-muted">{x.detail}</span>}
          </span>
        </div>
      ))}
    </>
  );
}

function FoldBody({ fold }: { fold: TraceFold }) {
  if (fold.kind === "plan") return fold.steps.map((s) => <PlanStep key={s.id} step={s} waiting={fold.waiting} />);
  return (
    <ul className="flex flex-col gap-3 pt-1">
      {fold.items.map((x) => (
        <li key={x.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1.5 text-[12.5px]">
          <span className={`truncate ${x.score === null ? "text-muted" : "text-text"}`}>{x.label}</span>
          <span className={x.best ? "text-primary" : "text-text"}>{x.score?.toFixed(2)}</span>
          {x.score !== null && (
            <span className="relative col-span-2 h-1 rounded-[2px] bg-[rgba(255,255,255,0.08)]">
              <i className="absolute inset-y-0 left-0 rounded-[2px]" style={{ width: `${x.score * 100}%`, background: x.best ? "var(--primary)" : "rgba(237,238,240,0.6)" }} />
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** beautifului.dev Approval Card actions, under the question. */
function Actions() {
  const approval = useDash((s) => s.approval);
  if (approval?.state !== "pending") return null;
  return (
    <div className="-mt-2 flex gap-2">
      <button
        type="button"
        onClick={() => demo.resolveApproval(false)}
        className="flex h-[34px] items-center gap-1.5 rounded-[10px] px-3.5 text-[13px] font-medium text-text transition-colors duration-100 hover:bg-raised active:scale-[0.97]"
      >
        <IconX size={13} />
        {approval.rejectLabel ?? "Reject"}
      </button>
      <button
        type="button"
        onClick={() => demo.resolveApproval(true)}
        className="flex h-[34px] items-center gap-1.5 rounded-[10px] bg-primary px-4 text-[13px] font-semibold text-[#04141a] transition-transform duration-150 active:scale-[0.97]"
      >
        <IconCheck size={13} />
        {approval.approveLabel ?? "Approve"}
      </button>
    </div>
  );
}

function Details({ node }: { node: TraceNode }) {
  const p: TracePanel = node.panel;
  const s = STATUS[node.status];
  const Icon = NODE_ICON[node.id] ?? NODE_ICON.agent;

  return (
    <aside className="surface raised flex w-[clamp(300px,27vw,380px)] shrink-0 flex-col overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-6 pt-[18px]">
        <h2 className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-text">
          <Icon size={14} className="shrink-0 text-muted" />
          <span className="truncate">{node.title}</span>
        </h2>
        <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12.5px] font-medium" style={{ color: s.color }}>
          {s.icon}
          {p.status ?? s.label}
        </span>
      </header>
      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto px-6 pt-11 pb-5">
        {p.hero && <Hero hero={p.hero} />}
        {p.sentence && <p className={`text-[15px] leading-[1.55] ${p.quiet ? "text-muted" : "text-[rgba(237,238,240,0.9)]"}`}>{p.sentence}</p>}
        {p.actions && <Actions />}
        {p.fold && (
          <Fold fold={p.fold}>
            <FoldBody fold={p.fold} />
          </Fold>
        )}
      </div>
    </aside>
  );
}

function Logs({ logs, onSelect }: { logs: TraceLog[]; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [logs.length]);
  return (
    <div className="shrink-0 border-t border-[rgba(255,255,255,0.08)] bg-[rgba(10,12,15,0.55)]">
      <button type="button" onClick={() => setOpen(!open)} className="flex h-10 w-full items-center gap-2 px-4 text-[13px]">
        <span className="font-medium text-text">Logs</span>
        <span className="text-muted">{logs.length}</span>
        {!open && logs.length > 0 && (
          <span className="ml-3 truncate text-muted">
            {formatClock(logs[logs.length - 1].at)} · {logs[logs.length - 1].node} {logs[logs.length - 1].text}
          </span>
        )}
        <IconChevronDown size={14} className="ml-auto text-muted transition-transform duration-300" style={{ transform: open ? "none" : "rotate(180deg)" }} />
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-[400ms]"
        style={{ gridTemplateRows: open ? "1fr" : "0fr", transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)" }}
      >
        <div className="min-h-0 overflow-hidden">
          <div ref={ref} className="scroll-thin h-[132px] overflow-y-auto px-4 pb-3">
            {logs.map((l, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onSelect(l.nodeId)}
                className="flex h-7 w-full items-center gap-4 rounded-[6px] px-1 text-left text-[13px] transition-colors duration-100 hover:bg-[rgba(255,255,255,0.04)]"
              >
                <span className="w-12 shrink-0 font-mono text-[12px] text-muted">{formatClock(l.at)}</span>
                <span className="w-40 shrink-0 truncate text-text">{l.node}</span>
                <span className="truncate text-muted">{l.text}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function TracePage() {
  // Re-derive on every store change; the store already throttles to ~20 Hz.
  const state = useDash((s) => s);
  const trace = useMemo(() => deriveTrace(state), [state]);
  const [selected, setSelected] = useState("agent");
  const node = trace.nodes.find((n) => n.id === selected) ?? trace.nodes[0];

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE_ENTER }}
      className="relative z-10 flex min-h-0 flex-1 gap-4"
    >
      <section className="surface flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="relative min-h-0 flex-1">
          <TraceCanvas trace={trace} selected={node.id} onSelect={setSelected} />
        </div>
        <Logs logs={trace.logs} onSelect={setSelected} />
      </section>
      <Details key={node.id} node={node} />
    </motion.div>
  );
}
