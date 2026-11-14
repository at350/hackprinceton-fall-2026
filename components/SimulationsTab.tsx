"use client";

import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { drawDimBrain, loadBrain, renderScanned } from "@/lib/brain";
import { LIVE } from "@/lib/live";
import type { RegionAgent, Simulation } from "@/lib/types";
import { HEAD } from "@/lib/mock";
import { useDash } from "@/lib/useDash";
import { IconCheck, IconClock, IconTarget, Ring } from "./icons";
import { SimDetail } from "./SimDetail";
import { EASE_EXPO } from "./ui";

const TYPE_LABEL = { epidural: "Epidural", subdural: "Subdural", intraparenchymal: "Intraparenchymal" };
// Simulations the agents added after the planned sweep say so in the status word.
const PASS_STATUS = { coarse: ["Running", "Done"], refine: ["Refining", "Refined"], review: ["Second check", "Second check"] };
const EASE_UI = [0.23, 1, 0.32, 1] as const;

/** Beautiful UI task row: 44px capsule, icon left, count and status right. */
function AgentRow({ a }: { a: RegionAgent }) {
  const done = a.state === "done";
  return (
    <div className="glass flex h-11 items-center gap-2.5 rounded-[22px] pr-2 pl-3">
      <span className={`grid size-5 place-items-center ${a.state === "running" ? "text-primary" : "text-muted"}`}>
        {done ? (
          <span className="grid size-[18px] place-items-center rounded-full bg-text text-bg">
            <IconCheck size={11} strokeWidth={2.4} />
          </span>
        ) : a.state === "running" ? (
          <Ring progress={a.done / a.total} size={18} />
        ) : (
          <IconClock size={16} />
        )}
      </span>
      <span className="truncate text-[13.5px] font-medium capitalize text-text">{a.region}</span>
      <span
        className={`ml-auto shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-medium transition-colors duration-300 ${
          done ? "bg-[rgba(255,255,255,0.12)] text-text" : a.state === "running" ? "text-primary" : "text-muted"
        }`}
      >
        {done ? (
          "Done"
        ) : a.state === "running" ? (
          <>
            <span className="hidden min-[1360px]:inline">Running </span>
            {a.done}/{a.total}
          </>
        ) : (
          "Idle"
        )}
      </span>
    </div>
  );
}

/** The brain render with this hypothesis's heat. */
function Thumb({ sim }: { sim: Simulation }) {
  const base = useRef<HTMLCanvasElement>(null);
  const top = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    loadBrain().then(() => setLoaded(true));
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const size = Math.round(base.current!.clientWidth * devicePixelRatio);
    for (const c of [base.current!, top.current!]) c.width = c.height = size;
    drawDimBrain(base.current!.getContext("2d")!, size, 0.3);
    top.current!.getContext("2d")!.drawImage(renderScanned(sim.map, size, false), 0, 0);
  }, [loaded, sim.map]);

  // The heat appears only when the run is done: a partial fade would imply a
  // partial result the solver doesn't produce. Progress lives in the bar below.
  return (
    <div className="relative aspect-square w-[clamp(56px,5.2vw,76px)] shrink-0">
      <canvas ref={base} className="absolute inset-0 size-full" />
      <canvas
        ref={top}
        className="absolute inset-0 size-full"
        style={{ opacity: sim.status === "done" ? 1 : 0, transition: "opacity 400ms cubic-bezier(0.23,1,0.32,1)" }}
      />
      {sim.status === "running" && (
        // Soft progress line traced around the brain, starting at the front.
        <svg
          viewBox="-1 -1 2 2"
          className="absolute inset-0 size-full -rotate-90 overflow-visible"
          style={{ filter: "drop-shadow(0 0 1.5px rgba(34,195,230,0.9)) drop-shadow(0 0 5px rgba(34,195,230,0.55))" }}
          aria-hidden
        >
          <ellipse rx={HEAD.ry * 1.04} ry={HEAD.rx * 1.06} fill="none" stroke="rgba(34,195,230,0.12)" strokeWidth={0.024} />
          <ellipse
            rx={HEAD.ry * 1.04}
            ry={HEAD.rx * 1.06}
            fill="none"
            stroke="#22c3e6"
            strokeWidth={0.03}
            strokeLinecap="round"
            pathLength={1}
            strokeDasharray="1 1"
            strokeDashoffset={1 - sim.progress}
            style={{ transition: "stroke-dashoffset 300ms linear" }}
          />
        </svg>
      )}
    </div>
  );
}

function SimCard({ sim, best, onOpen }: { sim: Simulation; best: boolean; onOpen?: (id: string) => void }) {
  const [running, done] = PASS_STATUS[sim.pass ?? "coarse"];
  const status = best
    ? { text: "Best fit", el: <IconTarget size={13} />, color: "var(--primary)" }
    : sim.status === "done"
      ? { text: done, el: <IconCheck size={12} strokeWidth={1.8} />, color: "var(--muted)" }
      : sim.status === "running"
        ? { text: running, el: null, color: "var(--primary)" }
        : { text: "Queued", el: <IconClock size={12} strokeWidth={1.8} />, color: "var(--muted)" };
  return (
    <motion.li
      layout="position"
      transition={{ layout: { duration: 0.5, ease: EASE_UI } }}
      // Off-screen cards skip rendering: a live run fills the grid with about a hundred.
      className={`glass flex flex-col gap-3 p-3 transition-[border-color,opacity] duration-300 [contain-intrinsic-size:auto_136px] [content-visibility:auto] ${best ? "!border-primary" : "dim"} ${
        sim.status === "queued" ? "opacity-60" : ""
      } ${onOpen ? `cursor-pointer ${best ? "" : "hover:border-line-strong"}` : ""}`}
      {...(onOpen && {
        role: "button",
        tabIndex: 0,
        onClick: () => onOpen(sim.id),
        onKeyDown: (e: React.KeyboardEvent) => e.key === "Enter" && onOpen(sim.id),
      })}
    >
      <div className="flex items-start gap-3">
        <Thumb sim={sim} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
          <span className="flex items-center gap-1.5 whitespace-nowrap text-[12px] font-medium" style={{ color: status.color }}>
            {status.el}
            {status.text}
          </span>
          <span className="truncate text-[14px] font-medium leading-tight text-text">{TYPE_LABEL[sim.type]}</span>
          <span className="truncate text-[12.5px] leading-tight text-muted">
            {sim.region} · {sim.volume_ml} mL
          </span>
        </div>
      </div>
      {/* One bar per card (Vercel Geist progress): run progress while running, fit score once done. */}
      <div className="flex items-center gap-3">
        <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-[rgba(255,255,255,0.08)]">
          <motion.div
            className="h-full rounded-full"
            style={{ background: best ? "var(--primary)" : "var(--text)" }}
            initial={{ width: 0 }}
            animate={{ width: sim.status === "done" ? `${sim.score * 100}%` : "0%" }}
            transition={{ duration: 0.8, ease: EASE_EXPO }}
          />
        </div>
        {sim.status === "running" ? (
          <span className="w-12 text-right text-[13px] font-medium leading-none text-muted">{Math.round(sim.progress * 100)}%</span>
        ) : (
          <span className="w-12 text-right text-[22px] font-medium leading-none tracking-[-0.04em] text-text" title="Fit score">
            {sim.status === "done" ? sim.score.toFixed(2) : "--"}
          </span>
        )}
      </div>
    </motion.li>
  );
}

const RANK = { running: 0, done: 1, queued: 2 } as const;

export function SimulationsTab() {
  const sims = useDash((s) => s.sims);
  const agents = useDash((s) => s.agents);
  // Live mode: the simulation whose detail replaces the grid.
  const [openId, setOpenId] = useState<string | null>(null);
  const open = openId ? sims.find((s) => s.id === openId) : undefined;
  // Where the grid was scrolled to when a card was opened, to return to the same place.
  const scrolled = useRef(0);

  const { ordered, bestId } = useMemo(() => {
    const done = sims.filter((s) => s.status === "done");
    const best = done.length ? done.reduce((a, b) => (b.score > a.score ? b : a)) : null;
    // Best fit pinned first, then live runs, then finished by score, then the queue.
    const rest = sims
      .filter((s) => s !== best)
      .sort((a, b) => RANK[a.status] - RANK[b.status] || (a.status === "done" ? b.score - a.score : a.id.localeCompare(b.id)));
    return { ordered: best ? [best, ...rest] : rest, bestId: best?.id ?? null };
  }, [sims]);

  return (
    <div className="flex h-full flex-col">
      <div className="grid shrink-0 grid-cols-4 gap-2.5 px-5 pt-5">
        {agents.map((a) => (
          <AgentRow key={a.region} a={a} />
        ))}
      </div>
      {open ? (
        <div className="mt-4 min-h-0 flex-1 px-5 pb-5">
          <SimDetail key={open.id} sim={open} best={open.id === bestId} onBack={() => setOpenId(null)} />
        </div>
      ) : (
        <div
          ref={(el) => void (el && (el.scrollTop = scrolled.current))}
          onScroll={(e) => (scrolled.current = e.currentTarget.scrollTop)}
          className="scroll-thin mt-4 min-h-0 flex-1 overflow-y-auto px-5 pb-5"
        >
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2.5">
            {ordered.map((s) => (
              <SimCard key={s.id} sim={s} best={s.id === bestId} onOpen={LIVE ? setOpenId : undefined} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
