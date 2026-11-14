"use client";

import { useCallback, useEffect, useRef, useState, type ComponentType, type SVGProps } from "react";
import type { Trace, TraceNode } from "@/lib/trace";
import {
  IconAiChip,
  IconAtom,
  IconChart,
  IconCheck,
  IconDatabase,
  IconFullScreen,
  IconLayers,
  IconRanking,
  IconRobot,
  IconSent,
  IconTarget,
  IconUsb,
  IconUserCheck,
  IconZoomIn,
  IconZoomOut,
} from "./icons";

// Geometry follows n8n's canvas source (nodeViewUtils.ts, CanvasNodeDefault.vue):
// 16px grid, 96px nodes with a 16px radius, 80px circular configuration nodes,
// trigger nodes with a 36px left radius, agent tools as pills.
const GRID = 16;
type Shape = "node" | "trigger" | "agent" | "pill" | "circle";
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  shape: Shape;
}

const L: Record<string, Box> = {
  device: { x: 0, y: 0, w: 96, h: 96, shape: "trigger" },
  spots: { x: 176, y: 0, w: 96, h: 96, shape: "node" },
  map: { x: 352, y: 0, w: 96, h: 96, shape: "node" },
  agent: { x: 528, y: 0, w: 240, h: 96, shape: "agent" },
  rank: { x: 864, y: 0, w: 96, h: 96, shape: "node" },
  approval: { x: 1040, y: 0, w: 96, h: 96, shape: "node" },
  alert: { x: 1216, y: 0, w: 96, h: 96, shape: "node" },
  model: { x: 400, y: 208, w: 80, h: 80, shape: "circle" },
  memory: { x: 544, y: 208, w: 80, h: 80, shape: "circle" },
  "region-frontal": { x: 304, y: 384, w: 184, h: 64, shape: "pill" },
  "region-temporal": { x: 512, y: 384, w: 184, h: 64, shape: "pill" },
  "region-parietal": { x: 720, y: 384, w: 184, h: 64, shape: "pill" },
  "region-occipital": { x: 928, y: 384, w: 184, h: 64, shape: "pill" },
  forward_sim: { x: 576, y: 544, w: 80, h: 80, shape: "circle" },
  fit_score: { x: 784, y: 544, w: 80, h: 80, shape: "circle" },
};

// The agent's labelled connectors along its bottom edge (n8n: Chat Model, Memory, Tool).
const AGENT_PORTS = [
  { id: "model", label: "Chat Model", dx: 48 },
  { id: "memory", label: "Memory", dx: 120 },
  { id: "tool", label: "Tool", dx: 192 },
];

const ICON: Record<string, ComponentType<SVGProps<SVGSVGElement> & { size?: number }>> = {
  device: IconUsb,
  spots: IconTarget,
  map: IconLayers,
  agent: IconRobot,
  rank: IconRanking,
  approval: IconUserCheck,
  alert: IconSent,
  model: IconAiChip,
  memory: IconDatabase,
  forward_sim: IconAtom,
  fit_score: IconChart,
};

const CYAN = "#22c3e6";
const BOUNDS = { x: -56, y: -24, w: 1424, h: 712 };

function portOf(nodeId: string): { x: number; y: number } {
  const a = L.agent;
  if (nodeId === "model") return { x: a.x + AGENT_PORTS[0].dx, y: a.y + a.h };
  if (nodeId === "memory") return { x: a.x + AGENT_PORTS[1].dx, y: a.y + a.h };
  return { x: a.x + AGENT_PORTS[2].dx, y: a.y + a.h };
}

/** n8n non-main links: Bézier, dashed 5,6, no arrow. Drawn from the sub-node up to its port. */
function aiPath(from: { x: number; y: number }, to: { x: number; y: number }) {
  const dy = Math.max(40, (from.y - to.y) / 2);
  return `M ${from.x} ${from.y} C ${from.x} ${from.y - dy}, ${to.x} ${to.y + dy}, ${to.x} ${to.y}`;
}

function Edges({ trace }: { trace: Trace }) {
  const byId = Object.fromEntries(trace.nodes.map((n) => [n.id, n]));
  const main = trace.edges.filter((e) => e.kind === "main");
  // Region agents feed the agent's Tool port; the two tools feed every region agent's Tool port.
  const ai: { d: string; key: string }[] = [];
  for (const e of trace.edges.filter((x) => x.kind === "ai" && !x.from.endsWith("_sim") && x.from !== "fit_score")) {
    const b = L[e.from];
    const src = { x: b.x + b.w / 2, y: b.y };
    ai.push({ key: `${e.from}-agent`, d: aiPath(src, portOf(e.from)) });
  }
  for (const tool of ["forward_sim", "fit_score"]) {
    for (const r of ["frontal", "temporal", "parietal", "occipital"]) {
      const t = L[tool];
      const p = L[`region-${r}`];
      ai.push({ key: `${tool}-${r}`, d: aiPath({ x: t.x + t.w / 2, y: t.y }, { x: p.x + p.w / 2, y: p.y + p.h }) });
    }
  }
  return (
    <svg className="pointer-events-none absolute overflow-visible" style={{ left: 0, top: 0, width: 1, height: 1 }}>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
        </marker>
      </defs>
      {ai.map((e) => (
        <path key={e.key} d={e.d} fill="none" stroke="rgba(255,255,255,0.32)" strokeWidth={2} strokeDasharray="5 6" />
      ))}
      {main.map((e) => {
        const a = L[e.from];
        const b = L[e.to];
        const x1 = a.x + a.w + 8;
        const y = a.y + a.h / 2;
        const x2 = b.x - 6;
        const items = byId[e.from]?.status === "success" || byId[e.from]?.status === "waiting" ? byId[e.from]?.items : null;
        const lit = !!items;
        return (
          <g key={`${e.from}-${e.to}`}>
            <path d={`M ${x1} ${y} L ${x2} ${y}`} fill="none" stroke={lit ? CYAN : "rgba(255,255,255,0.32)"} strokeWidth={2} markerEnd="url(#arrow)" />
            {lit && (
              <g transform={`translate(${(x1 + x2) / 2} ${y - 14})`}>
                <rect x={-30} y={-10} width={60} height={18} rx={4} fill="rgba(20,22,27,0.85)" />
                <text textAnchor="middle" y={3} fontSize={13} fill="#acb5c0">
                  {items} item{items === 1 ? "" : "s"}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Running and waiting: n8n's rotating conic border (1.5s running, 4.5s waiting). */
function RunBorder({ box, slow }: { box: Box; slow: boolean }) {
  const r = box.shape === "circle" ? 999 : box.shape === "pill" ? 999 : 16;
  return (
    <span className="pointer-events-none absolute -inset-[3px] overflow-hidden" style={{ borderRadius: r === 999 ? 999 : r + 3 }}>
      <span
        className="absolute top-1/2 left-1/2 aspect-square w-[300%]"
        style={{
          background: `conic-gradient(${CYAN}, rgba(34,195,230,0.2) 40%, rgba(34,195,230,0.2) 60%, ${CYAN})`,
          animation: `trace-spin ${slow ? 4.5 : 1.5}s linear infinite`,
        }}
      />
    </span>
  );
}

function NodeView({ node, selected, onSelect }: { node: TraceNode; selected: boolean; onSelect: () => void }) {
  const box = L[node.id];
  if (!box) return null;
  const Icon = ICON[node.id] ?? IconRobot;
  const success = node.status === "success";
  const error = node.status === "error";
  const radius =
    box.shape === "circle" || box.shape === "pill"
      ? 999
      : box.shape === "trigger"
        ? "36px 16px 16px 36px"
        : 16;
  const border = success ? `2px solid ${CYAN}` : error ? "2px solid #ff9479" : "1.5px solid rgba(255,255,255,0.15)";
  const inline = box.shape === "agent" || box.shape === "pill";

  return (
    <div className="absolute" style={{ left: box.x, top: box.y, width: box.w }}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        aria-label={`${node.title}, ${node.status}`}
        className="relative block w-full"
        style={{ height: box.h }}
      >
        {(node.status === "running" || node.status === "waiting") && <RunBorder box={box} slow={node.status === "waiting"} />}
        {/* n8n selected: 6px outer ring at 40% white. */}
        {selected && <span className="absolute -inset-[7px]" style={{ borderRadius: radius === 999 ? 999 : box.shape === "trigger" ? "42px 22px 22px 42px" : 22, boxShadow: "0 0 0 6px rgba(255,255,255,0.4)" }} />}
        <span
          className={`relative flex size-full items-center ${inline ? "justify-start gap-3 px-5" : "justify-center"}`}
          style={{ borderRadius: radius, border, background: "#262a31" }}
        >
          <Icon size={box.shape === "circle" ? 30 : inline ? 26 : 40} className={node.status === "idle" ? "text-muted" : "text-text"} />
          {inline && (
            <span className="flex min-w-0 flex-col items-start leading-tight">
              <span className="truncate text-[15px] font-medium text-text">{node.title}</span>
              {box.shape === "pill" && (
                <span className="text-[12px] text-muted">{node.items ? `${node.items} of 6 run` : node.subtitle}</span>
              )}
            </span>
          )}
          {/* n8n success mark, bottom-right. */}
          {success && !inline && (
            <span className="absolute right-2 bottom-1.5" style={{ color: CYAN }}>
              <IconCheck size={16} />
            </span>
          )}
        </span>
        {/* Handles: input as a small bar on the left, output as a dot on the right. */}
        {(box.shape === "node" || box.shape === "agent") && (
          <span className="absolute top-1/2 -left-[4px] h-4 w-[6px] -translate-y-1/2 rounded-[2px] bg-[#8a8f98]" />
        )}
        {(box.shape === "node" || box.shape === "agent" || box.shape === "trigger") && node.id !== "alert" && (
          <span className="absolute top-1/2 -right-[7px] size-3.5 -translate-y-1/2 rounded-full border border-[#8a8f98] bg-[#262a31]" />
        )}
        {/* Configuration nodes connect up through a diamond on top. */}
        {(box.shape === "circle" || box.shape === "pill") && (
          <span className="absolute -top-[5px] left-1/2 size-2.5 -translate-x-1/2 rotate-45 bg-[#8a8f98]" />
        )}
        {box.shape === "pill" && (
          <span className="absolute -bottom-[5px] left-1/2 size-2.5 -translate-x-1/2 rotate-45 bg-[#8a8f98]" />
        )}
      </button>

      {/* Agent ports with labels. */}
      {box.shape === "agent" &&
        AGENT_PORTS.map((p) => (
          <span key={p.id} className="absolute flex flex-col items-center" style={{ left: p.dx, top: box.h - 5, transform: "translateX(-50%)" }}>
            <span className="size-2.5 rotate-45 bg-[#8a8f98]" />
            <span className="mt-1.5 text-[11px] text-muted">{p.label}</span>
          </span>
        ))}
      {box.shape === "pill" && (
        <span className="absolute left-1/2 -translate-x-1/2 text-[11px] text-muted" style={{ top: box.h + 8 }}>
          Tool
        </span>
      )}

      {!inline && (
        <div className="absolute left-1/2 flex w-[180px] -translate-x-1/2 flex-col items-center text-center" style={{ top: box.h + 10 }}>
          <span className="text-[14px] font-medium leading-tight text-text">{node.title}</span>
          <span className="mt-0.5 text-[12px] leading-tight text-muted">{node.subtitle}</span>
        </div>
      )}
    </div>
  );
}

export function TraceCanvas({ trace, selected, onSelect }: { trace: Trace; selected: string; onSelect: (id: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const fit = useCallback(() => {
    const el = host.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const k = Math.min(1, (width - 48) / BOUNDS.w, (height - 96) / BOUNDS.h);
    setView({ k, x: (width - BOUNDS.w * k) / 2 - BOUNDS.x * k, y: (height - 56 - BOUNDS.h * k) / 2 - BOUNDS.y * k });
  }, []);

  useEffect(() => {
    fit();
    const ro = new ResizeObserver(fit);
    if (host.current) ro.observe(host.current);
    return () => ro.disconnect();
  }, [fit]);

  // The canvas rect comes from the event, so nothing reads the ref during render.
  const zoom = (r: DOMRect, factor: number, cx?: number, cy?: number) => {
    const px = cx ?? r.width / 2;
    const py = cy ?? r.height / 2;
    setView((v) => {
      const k = Math.min(2, Math.max(0.25, v.k * factor));
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });
  };

  return (
    <div
      ref={host}
      data-trace-canvas
      className="relative size-full cursor-grab overflow-hidden active:cursor-grabbing"
      // n8n canvas: dot grid on a 16px pitch, scaled with zoom.
      style={{
        backgroundImage: "radial-gradient(rgba(255,255,255,0.14) 1px, transparent 1.2px)",
        backgroundSize: `${GRID * view.k}px ${GRID * view.k}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
      }}
      onPointerUp={() => (drag.current = null)}
      onWheel={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        zoom(r, e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
      }}
    >
      <style>{`@keyframes trace-spin { from { transform: translate(-50%,-50%) rotate(0deg) } to { transform: translate(-50%,-50%) rotate(360deg) } }`}</style>
      <div className="absolute top-0 left-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        <Edges trace={trace} />
        {trace.nodes.map((n) => (
          <NodeView key={n.id} node={n} selected={n.id === selected} onSelect={() => onSelect(n.id)} />
        ))}
      </div>

      {/* n8n: fit view / zoom in / zoom out, bottom left. */}
      <div className="absolute bottom-4 left-4 flex gap-2" onPointerDown={(e) => e.stopPropagation()}>
        {[
          { label: "Fit view", Icon: IconFullScreen, factor: 0 },
          { label: "Zoom in", Icon: IconZoomIn, factor: 1.2 },
          { label: "Zoom out", Icon: IconZoomOut, factor: 1 / 1.2 },
        ].map(({ label, Icon, factor }) => (
          <button
            key={label}
            type="button"
            aria-label={label}
            onClick={(e) => {
              if (!factor) return fit();
              const canvas = e.currentTarget.closest("[data-trace-canvas]") as HTMLElement;
              zoom(canvas.getBoundingClientRect(), factor);
            }}
            className="grid size-10 place-items-center rounded-[8px] border border-[rgba(255,255,255,0.14)] bg-[rgba(20,22,27,0.8)] text-muted transition-colors duration-150 hover:text-text"
          >
            <Icon size={18} />
          </button>
        ))}
      </div>
    </div>
  );
}
