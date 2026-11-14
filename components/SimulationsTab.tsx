"use client";

import { motion } from "motion/react";
import { useEffect, useMemo, useRef } from "react";
import { HEAD } from "@/lib/mock";
import type { RegionAgent, Simulation } from "@/lib/types";
import { useDash } from "@/lib/useDash";
import { IconCheck, IconClock, IconTarget, Wave } from "./icons";
import { EASE_EXPO, paintGrid } from "./ui";

const TYPE_LABEL = { epidural: "Epidural", subdural: "Subdural", intraparenchymal: "Intraparenchymal" };

function AgentProgress({ a }: { a: RegionAgent }) {
  const state =
    a.state === "done"
      ? { text: "Done", el: <IconCheck size={13} strokeWidth={1.7} />, color: "var(--text)" }
      : a.state === "running"
        ? { text: "Running", el: <Wave height={10} />, color: "var(--primary)" }
        : { text: "Idle", el: <IconClock size={13} strokeWidth={1.7} />, color: "var(--muted)" };
  return (
    <div className="flex flex-col gap-2.5 rounded-[12px] border border-line bg-raised px-3.5 py-3">
      <div className="flex items-center justify-between">
        <span className="text-[14px] font-medium capitalize text-text">{a.region}</span>
        <span className="flex items-center gap-1.5 text-[12px] font-medium" style={{ color: state.color }}>
          {state.el}
          {state.text}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex flex-1 gap-[3px]">
          {Array.from({ length: a.total }, (_, i) => (
            <span
              key={i}
              className="h-1 flex-1 rounded-full transition-colors duration-500"
              style={{ background: i < a.done ? "var(--text)" : "rgba(255,255,255,0.1)" }}
            />
          ))}
        </div>
        <span className="w-7 text-right text-[12px] text-muted">
          {a.done}/{a.total}
        </span>
      </div>
    </div>
  );
}

/** Small head map. Running sims draw in behind a sweeping line. */
function Thumb({ sim }: { sim: Simulation }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) paintGrid(ref.current, sim.map);
  }, [sim.map]);
  const reveal = sim.status === "done" ? 1 : sim.status === "running" ? sim.progress : 0;
  return (
    <div className="relative aspect-square w-[72px] shrink-0">
      <svg viewBox="-1.1 -1.1 2.2 2.2" className="absolute inset-0 size-full" aria-hidden>
        <ellipse rx={HEAD.rx * 1.03} ry={HEAD.ry * 1.03} fill="rgba(255,255,255,0.02)" stroke="var(--line-strong)" strokeWidth={0.03} />
      </svg>
      <div className="absolute overflow-hidden" style={{ inset: "4.5%", clipPath: `inset(0 0 ${(1 - reveal) * 100}% 0)` }}>
        <canvas ref={ref} className="size-full" style={{ imageRendering: "auto" }} />
      </div>
      {sim.status === "running" && (
        <span className="absolute inset-x-[10%] h-px bg-primary" style={{ top: `${4.5 + reveal * 91}%` }} />
      )}
    </div>
  );
}

function SimCard({ sim, best }: { sim: Simulation; best: boolean }) {
  const status =
    sim.status === "done"
      ? { text: "Done", el: <IconCheck size={12} strokeWidth={1.8} />, color: "var(--muted)" }
      : sim.status === "running"
        ? { text: "Running", el: <Wave height={9} />, color: "var(--primary)" }
        : { text: "Queued", el: <IconClock size={12} strokeWidth={1.8} />, color: "var(--muted)" };
  return (
    <motion.li
      layout
      transition={{ layout: { duration: 0.6, ease: EASE_EXPO } }}
      className={`relative flex flex-col gap-3 rounded-[12px] border p-3 transition-colors duration-300 ${
        best ? "border-primary bg-[rgba(34,195,230,0.05)]" : "border-line bg-raised"
      } ${sim.status === "queued" ? "opacity-55" : ""}`}
    >
      <div className="flex items-start gap-3">
        <Thumb sim={sim} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
          {best ? (
            <span className="flex items-center gap-1.5 text-[12px] font-medium text-primary">
              <IconTarget size={13} />
              Best fit
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-[12px] font-medium" style={{ color: status.color }}>
              {status.el}
              {status.text}
            </span>
          )}
          <span className="truncate text-[14px] font-medium leading-tight text-text">{TYPE_LABEL[sim.type]}</span>
          <span className="text-[12px] leading-tight text-muted">
            {sim.region} · {sim.volume_ml} mL
          </span>
        </div>
      </div>
      <div className="flex items-end justify-between gap-3">
        <span className="label">Fit</span>
        <span className="num-xl text-[22px] text-text">{sim.status === "done" ? sim.score.toFixed(2) : "--"}</span>
      </div>
      <div className="h-[3px] overflow-hidden rounded-full bg-[rgba(255,255,255,0.08)]">
        <motion.div
          className="h-full rounded-full"
          style={{ background: best ? "var(--primary)" : "var(--text)" }}
          animate={{ width: sim.status === "done" ? `${sim.score * 100}%` : "0%" }}
          transition={{ duration: 0.8, ease: EASE_EXPO }}
        />
      </div>
    </motion.li>
  );
}

const RANK = { running: 0, done: 1, queued: 2 } as const;

export function SimulationsTab() {
  const sims = useDash((s) => s.sims);
  const agents = useDash((s) => s.agents);

  const { ordered, bestId } = useMemo(() => {
    const done = sims.filter((s) => s.status === "done");
    const best = done.length ? done.reduce((a, b) => (b.score > a.score ? b : a)) : null;
    // Best fit pinned first, then live runs, then finished by score, then the queue.
    const rest = sims
      .filter((s) => s !== best)
      .sort((a, b) => RANK[a.status] - RANK[b.status] || (a.status === "done" ? b.score - a.score : a.id.localeCompare(b.id)));
    return { ordered: best ? [best, ...rest] : rest, bestId: best?.id ?? null };
  }, [sims]);

  const doneCount = sims.filter((s) => s.status === "done").length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-col gap-3 px-5 pt-4">
        <div className="grid grid-cols-4 gap-3">
          {agents.map((a) => (
            <AgentProgress key={a.region} a={a} />
          ))}
        </div>
      </div>
      <div className="scroll-thin mt-4 min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        <ul className="grid grid-cols-4 gap-3">
          {ordered.map((s) => (
            <SimCard key={s.id} sim={s} best={s.id === bestId} />
          ))}
        </ul>
      </div>
    </div>
  );
}
