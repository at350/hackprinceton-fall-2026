"use client";

import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { pointAt } from "@/lib/mock";
import { type HeadMesh, type SimSolve, bleedLayer, fieldLayer, loadMesh, loadSolve, tissueLayer } from "@/lib/solver";
import type { AgentActivity, ScanReading, Simulation } from "@/lib/types";
import { useDash } from "@/lib/useDash";
import { IconArrowRight, IconCheck, IconClock, IconTarget } from "./icons";

const TYPE_LABEL = { epidural: "Epidural", subdural: "Subdural", intraparenchymal: "Intraparenchymal" };
const PASS_LABEL = { coarse: "Coarse sweep", refine: "Refinement", review: "Second check" };
const EASE_UI = [0.23, 1, 0.32, 1] as const;

// Same framing as the brain view: the map covers [-1, 1], the view adds room for the spot markers.
const VIEW = 1.25;
const INSET = `${((VIEW - 1) / (2 * VIEW)) * 100}%`;
const MARKER_R = 1.16;
const SWEEP_MS = 800;
const FADE_MS = 280;

/** Signed, with a real minus sign. */
const signed = (v: number, digits: number) => `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(digits)}`;

// ---- A. The physics -------------------------------------------------------

/** The solver's head: tissue layers, the bleed, and the active spot's disturbance field. */
function HeadCanvas({ mesh, solve, spot }: { mesh: HeadMesh; solve: SimSolve; spot: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const layers = useRef<{ size: number; tissue: HTMLCanvasElement; bleed: HTMLCanvasElement; fields: (HTMLCanvasElement | null)[] } | null>(null);
  const last = useRef<number | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(ref.current!);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!width) return;
    const canvas = ref.current!;
    const size = Math.min(900, Math.round(width * devicePixelRatio));
    if (layers.current?.size !== size) {
      canvas.width = canvas.height = size;
      layers.current = { size, tissue: tissueLayer(mesh, size), bleed: bleedLayer(mesh, solve.blood, size), fields: Array(8).fill(null) };
      last.current = null;
    }
    const l = layers.current;
    const field = (i: number) => (l.fields[i] ??= fieldLayer(mesh, solve.change[i], size));
    const ctx = canvas.getContext("2d")!;
    const from = last.current;
    const start = performance.now();
    let raf = 0;
    // The field cross-fades from the previous spot's.
    const frame = () => {
      const k = from === null || from === spot ? 1 : Math.min(1, (performance.now() - start) / FADE_MS);
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(l.tissue, 0, 0);
      if (k < 1) {
        ctx.globalAlpha = 1 - k;
        ctx.drawImage(field(from!), 0, 0);
      }
      ctx.globalAlpha = k;
      ctx.drawImage(field(spot), 0, 0);
      ctx.globalAlpha = 1;
      ctx.drawImage(l.bleed, 0, 0);
      if (k < 1) raf = requestAnimationFrame(frame);
    };
    frame();
    last.current = spot;
    return () => cancelAnimationFrame(raf);
  }, [mesh, solve, spot, width]);

  return <canvas ref={ref} className="absolute" style={{ inset: INSET, width: `calc(100% - 2 * ${INSET})`, height: `calc(100% - 2 * ${INSET})` }} />;
}

function Head({
  mesh,
  solve,
  spot,
  held,
  onPick,
}: {
  mesh: HeadMesh | null;
  solve: SimSolve | null;
  spot: number;
  held: boolean;
  onPick: (i: number) => void;
}) {
  const vb = `${-VIEW} ${-VIEW} ${VIEW * 2} ${VIEW * 2}`;
  const pair: number[] = mesh?.spot_pairs[spot] ?? [];
  return (
    <div className="relative aspect-square w-full">
      {mesh && solve && <HeadCanvas mesh={mesh} solve={solve} spot={spot} />}
      <svg viewBox={vb} className="absolute inset-0 size-full" role="img" aria-label="Head model from above with the simulated bleed, 16 electrodes and 8 scan spots">
        {mesh?.electrodes.map((n, k) => {
          const on = pair.includes(k);
          return (
            <circle
              key={k}
              cx={mesh.nodes[n][0]}
              cy={mesh.nodes[n][1]}
              r={on ? 0.03 : 0.017}
              fill={on ? "var(--primary)" : "var(--bg)"}
              stroke={on ? "none" : "rgba(255,255,255,0.4)"}
              strokeWidth={0.006}
              style={{ transition: "r 200ms cubic-bezier(0.23,1,0.32,1)" }}
            />
          );
        })}
        <text x={-0.98} y={0.02} fontSize={0.06} fontWeight={500} fill="var(--muted)" textAnchor="middle">L</text>
        <text x={0.98} y={0.02} fontSize={0.06} fontWeight={500} fill="var(--muted)" textAnchor="middle">R</text>
        {/* The spot markers of the brain view; here they pick the spot to hold. */}
        {Array.from({ length: 8 }, (_, i) => {
          const p = pointAt(i * 45, MARKER_R);
          const on = i === spot;
          return (
            <g
              key={i}
              role="button"
              tabIndex={0}
              aria-label={`Spot ${i + 1}${on && held ? ", held" : ""}`}
              aria-pressed={on && held}
              onClick={() => onPick(i)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onPick(i)}
              className="cursor-pointer outline-none"
            >
              {on && held && <circle cx={p.x} cy={p.y} r={0.082} fill="none" stroke="var(--primary)" strokeWidth={0.006} />}
              <circle
                cx={p.x}
                cy={p.y}
                r={0.062}
                fill={on ? "var(--primary)" : "rgba(20,23,28,0.6)"}
                stroke={on ? "none" : "rgba(255,255,255,0.14)"}
                strokeWidth={0.005}
              />
              <text x={p.x} y={p.y + 0.021} textAnchor="middle" fontSize={on ? 0.06 : 0.056} fontWeight={on ? 600 : 500} fill={on ? "#06121a" : "var(--muted)"}>
                {i + 1}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---- B. Simulated vs measured ---------------------------------------------

/** One row of 8 spots: a bar for the simulated change, a tick for the measured one. */
function SpotChart({
  label,
  sim,
  scan,
  minSpan,
  spot,
  onPick,
}: {
  label: string;
  sim: number[];
  scan: number[] | null;
  minSpan: number;
  spot: number;
  onPick: (i: number) => void;
}) {
  const all = [...sim, ...(scan ?? [])];
  let lo = Math.min(0, ...all);
  const hi = Math.max(0, ...all);
  // A flat reading stays flat instead of filling the row with noise.
  if (hi - lo < minSpan) lo = hi - minSpan;
  const y = (v: number) => `${((hi - v) / (hi - lo)) * 100}%`;
  return (
    <div className="flex items-stretch gap-3">
      <span className="w-14 shrink-0 self-center text-[12px] leading-tight text-muted">{label}</span>
      <div className="grid h-[52px] min-w-0 flex-1 grid-cols-8">
        {sim.map((v, i) => (
          <button
            key={i}
            type="button"
            tabIndex={-1}
            aria-hidden
            onClick={() => onPick(i)}
            className={`relative transition-colors duration-200 ${i === spot ? "bg-[rgba(255,255,255,0.05)]" : "hover:bg-[rgba(255,255,255,0.03)]"}`}
          >
            <span className="absolute inset-x-0 h-px bg-[rgba(255,255,255,0.12)]" style={{ top: y(0) }} />
            <span
              className="absolute left-1/2 w-[5px] -translate-x-1/2 rounded-[1px] bg-primary"
              style={{ top: y(Math.max(0, v)), bottom: `calc(100% - ${y(Math.min(0, v))})`, minHeight: 1 }}
            />
            {scan && <span className="absolute left-1/2 h-[2px] w-[17px] -translate-x-1/2 -translate-y-1/2 bg-text" style={{ top: y(scan[i]) }} />}
          </button>
        ))}
      </div>
    </div>
  );
}

function Compare({
  sim,
  solve,
  reading,
  best,
  spot,
  onPick,
}: {
  sim: Simulation;
  solve: SimSolve | null;
  reading: ScanReading | null;
  best: boolean;
  spot: number;
  onPick: (i: number) => void;
}) {
  const simulated = sim.reading ?? solve?.reading;
  if (!simulated) return <div className="h-[150px]" />;
  const healthy = { coil: solve?.healthy.coil_db[0] ?? -38.2, nir: solve?.healthy.nir[0] ?? 0.612 };
  // The scan joins the chart once the simulation has been scored against it.
  const scan = sim.status === "done" && reading?.spots.length === 8 ? reading.spots : null;
  const weak = new Set(reading?.spots.filter((s) => s.quality === "weak").map((s) => s.index));

  // The spot where simulation and scan are furthest apart, in units of expected error.
  let gap: string | null = null;
  if (sim.status === "done" && sim.misfit) {
    const { coil, nir } = sim.misfit;
    let k = 0;
    for (let i = 1; i < 8; i++) if (Math.max(Math.abs(coil[i]), Math.abs(nir[i])) > Math.max(Math.abs(coil[k]), Math.abs(nir[k]))) k = i;
    const byCoil = Math.abs(coil[k]) >= Math.abs(nir[k]);
    const m = byCoil ? coil[k] : nir[k];
    const name = reading?.spots[k]?.name ?? solve?.spots[k] ?? "";
    gap =
      Math.abs(m) < 1
        ? "All 8 spots agree with the scan within the expected error"
        : `Spot ${k + 1}, ${name}, disagrees most: simulated ${byCoil ? "coil" : "NIR"} is ${Math.abs(m).toFixed(1)}× the expected error ${m < 0 ? "below" : "above"} the scan`;
  }

  return (
    <div className="flex flex-col gap-2">
      <SpotChart label="Coil, dB" sim={simulated.coil_db.map((v) => v - healthy.coil)} scan={scan && scan.map((s) => s.coil_db - healthy.coil)} minSpan={0.5} spot={spot} onPick={onPick} />
      <SpotChart label="NIR" sim={simulated.nir.map((v) => v - healthy.nir)} scan={scan && scan.map((s) => s.nir - healthy.nir)} minSpan={0.01} spot={spot} onPick={onPick} />
      <div className="flex items-center gap-3 text-[12px] text-muted">
        <span className="w-14 shrink-0" />
        <div className="grid min-w-0 flex-1 grid-cols-8 text-center">
          {Array.from({ length: 8 }, (_, i) => (
            <span key={i} className={i === spot ? "text-primary" : weak.has(i) ? "text-uncertain" : ""} title={weak.has(i) ? "Weak contact" : undefined}>
              {i + 1}
            </span>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-[68px] text-[12px] text-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-[5px] rounded-[1px] bg-primary" />
          Simulated
        </span>
        {scan && (
          <span className="flex items-center gap-1.5">
            <span className="h-[2px] w-3.5 bg-text" />
            Scan
          </span>
        )}
        {weak.size > 0 && <span className="text-uncertain">{[...weak].map((i) => i + 1).join(", ")} weak contact</span>}
        <span>Change from healthy</span>
      </div>
      {sim.status === "done" && (
        <div className="mt-2 flex items-center gap-3.5">
          <span className="text-[30px] font-medium leading-none tracking-[-0.04em]" style={{ color: best ? "var(--primary)" : "var(--text)" }} title="Fit score">
            {sim.score.toFixed(2)}
          </span>
          <p className="min-w-0 text-[13px] leading-[1.45] text-muted">{gap}</p>
        </div>
      )}
    </div>
  );
}

// ---- C. What the agent is doing -------------------------------------------

function activityLine(a: AgentActivity) {
  const n = a.ids?.length ?? 0;
  switch (a.tool) {
    case null:
      return a.text ?? "";
    case "read_file":
      return `Read ${a.path ?? "a file"}`;
    case "write_file":
    case "edit_file":
      return `Wrote ${a.path ?? "a file"}`;
    case "forward_sim":
      return `Simulating ${n} ${n === 1 ? "hypothesis" : "hypotheses"}${a.note ? `: ${a.note}` : ""}`;
    case "fit_score":
      return `Scoring ${n}`;
    default: {
      const words = a.tool.replace(/_/g, " ");
      return words[0].toUpperCase() + words.slice(1);
    }
  }
}

function AgentLog({ sim }: { sim: Simulation }) {
  const who = sim.by ?? sim.agent;
  const log = useDash((s) => s.activity?.[who]);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log?.length]);

  const name = who === "skeptic" ? "Skeptic" : `${who[0].toUpperCase()}${who.slice(1)} agent`;
  return (
    <div className="flex min-h-[96px] flex-1 flex-col gap-2">
      <p className="text-[13.5px] leading-[1.5] text-text">
        {sim.by ? name : `Waiting for the ${sim.agent} agent`}
        <span className="text-muted"> · {PASS_LABEL[sim.pass ?? "coarse"]}</span>
        {sim.note && sim.note.toLowerCase() !== PASS_LABEL[sim.pass ?? "coarse"].toLowerCase() && <span className="line-clamp-2 text-muted">{sim.note}</span>}
      </p>
      <div ref={scroller} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {/* Same nesting as the plan's tool calls. Lines about this hypothesis are lit. */}
        <ul className="ml-[7px] flex flex-col gap-1.5 border-l border-[rgba(255,255,255,0.08)] py-0.5 pl-4 text-[13px] leading-[1.45]">
          {log?.map((a, i) => (
            <li key={i} className={a.ids?.includes(sim.id) ? "text-text" : "text-muted opacity-70"}>
              {activityLine(a)}
            </li>
          ))}
          {!log?.length && <li className="text-muted opacity-70">Nothing yet</li>}
        </ul>
      </div>
    </div>
  );
}

// ---- Detail ---------------------------------------------------------------

/** One hypothesis: the solver's picture of it, its reading against the scan, and the agent working on it. */
export function SimDetail({ sim, best, onBack }: { sim: Simulation; best: boolean; onBack: () => void }) {
  const reading = useDash((s) => s.reading ?? null);
  const [mesh, setMesh] = useState<HeadMesh | null>(null);
  const [solve, setSolve] = useState<SimSolve | null>(null);
  const [failed, setFailed] = useState(false);
  // The view sweeps the 8 spots like the device does, until the medic holds one.
  const [auto, setAuto] = useState(0);
  const [held, setHeld] = useState<number | null>(null);
  const spot = held ?? auto;

  useEffect(() => {
    let on = true;
    Promise.all([loadMesh(), loadSolve(sim.id)]).then(
      ([m, s]) => on && (setMesh(m), setSolve(s)),
      () => on && setFailed(true),
    );
    return () => {
      on = false;
    };
  }, [sim.id]);

  useEffect(() => {
    if (held !== null || !solve) return;
    const id = setInterval(() => setAuto((a) => (a + 1) % 8), SWEEP_MS);
    return () => clearInterval(id);
  }, [held, solve]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onBack();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onBack]);

  // Picking the held spot again lets the sweep carry on from there.
  const pick = (i: number) => {
    setAuto(i);
    setHeld(held === i ? null : i);
  };

  const status = best
    ? { text: "Best fit", el: <IconTarget size={13} />, color: "var(--primary)" }
    : sim.status === "done"
      ? { text: "Done", el: <IconCheck size={12} strokeWidth={1.8} />, color: "var(--muted)" }
      : sim.status === "running"
        ? { text: "Running", el: null, color: "var(--primary)" }
        : { text: "Queued", el: <IconClock size={12} strokeWidth={1.8} />, color: "var(--muted)" };
  const coil = solve ? solve.reading.coil_db[spot] - solve.healthy.coil_db[spot] : null;
  const nir = solve ? solve.reading.nir[spot] - solve.healthy.nir[spot] : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: EASE_UI }}
      className="flex h-full min-h-0 flex-col gap-3"
    >
      <header className="flex shrink-0 items-center gap-4">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1.5 flex h-7 shrink-0 items-center gap-1.5 rounded-[8px] px-1.5 text-[13px] text-muted transition-colors duration-100 hover:text-text"
        >
          <IconArrowRight size={13} className="rotate-180" />
          All simulations
        </button>
        <h2 className="min-w-0 truncate text-[15px] font-medium text-text">
          {TYPE_LABEL[sim.type]}
          <span className="font-normal text-muted">
            {" "}
            · {sim.region} · {sim.volume_ml} mL
          </span>
        </h2>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12px] font-medium" style={{ color: status.color }}>
          {status.el}
          {status.text}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 gap-6">
        <div className="flex w-[clamp(250px,50%,520px)] shrink-0 flex-col justify-center" style={{ containerType: "size" }}>
          <div className="mx-auto w-[min(100cqw,calc(100cqh-36px))]">
            <Head mesh={mesh} solve={solve} spot={spot} held={held !== null} onPick={pick} />
          </div>
          {/* What the device would read at the active spot, against a healthy head. */}
          <div className="flex h-9 shrink-0 items-end justify-center gap-7 whitespace-nowrap text-[13px] text-muted">
            {failed ? (
              <span>The solver is not reachable</span>
            ) : (
              solve && (
                <>
                  <span>
                    Spot {spot + 1} · {solve.spots[spot]}
                  </span>
                  <span>
                    Coil <span className="text-text">{signed(coil!, 2)} dB</span>
                  </span>
                  <span>
                    NIR <span className="text-text">{signed(nir!, 3)}</span>
                  </span>
                </>
              )
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-5">
          <Compare sim={sim} solve={solve} reading={reading} best={best} spot={spot} onPick={pick} />
          <AgentLog sim={sim} />
        </div>
      </div>
    </motion.div>
  );
}
