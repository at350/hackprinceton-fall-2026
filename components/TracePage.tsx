"use client";

import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { deriveTrace, type TraceNode } from "@/lib/trace";
import { formatClock, useDash } from "@/lib/useDash";
import { IconChevronDown, Spinner } from "./icons";
import { TraceCanvas } from "./TraceCanvas";
import { EASE_ENTER } from "./ui";

const STATUS: Record<TraceNode["status"], { label: string; color: string }> = {
  idle: { label: "Not run", color: "var(--muted)" },
  running: { label: "Running", color: "var(--primary)" },
  waiting: { label: "Waiting", color: "var(--primary)" },
  success: { label: "Success", color: "var(--primary)" },
  error: { label: "Rejected", color: "var(--bleed-text)" },
};

/** n8n node-details style: item count, then a bordered table. */
function DataTable({ rows, empty }: { rows: [string, string][]; empty: string }) {
  if (!rows.length) return <p className="text-[13px] text-muted">{empty}</p>;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[12.5px] text-muted">
        {rows.length} field{rows.length === 1 ? "" : "s"}
      </span>
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className="border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] px-3 py-2 text-left font-medium text-muted">field</th>
            <th className="border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] px-3 py-2 text-left font-medium text-muted">value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, v], i) => (
            <tr key={i}>
              <td className="border border-[rgba(255,255,255,0.08)] px-3 py-2 align-top text-muted">{k}</td>
              <td className="border border-[rgba(255,255,255,0.08)] px-3 py-2 align-top text-text">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Details({ node }: { node: TraceNode }) {
  const tabs = node.reasoning.length ? (["Output", "Input", "Reasoning"] as const) : (["Output", "Input"] as const);
  const [tab, setTab] = useState<(typeof tabs)[number]>(tabs[0]);
  const active = tabs.includes(tab as never) ? tab : tabs[0];
  const s = STATUS[node.status];
  const dur = node.startedAt !== null && node.endedAt !== null ? `${((node.endedAt - node.startedAt) / 1000).toFixed(1)}s` : null;

  return (
    <aside className="surface raised flex w-[clamp(300px,27vw,380px)] shrink-0 flex-col overflow-hidden">
      <header className="flex flex-col gap-1.5 px-4 pt-4 pb-3">
        <h2 className="text-[17px] font-medium tracking-[-0.02em] text-text">{node.title}</h2>
        <div className="flex items-center gap-2 text-[13px]">
          <span className="flex items-center gap-1.5 font-medium" style={{ color: s.color }}>
            {node.status === "running" && <Spinner size={12} />}
            {s.label}
          </span>
          {node.startedAt !== null && <span className="text-muted">· started {formatClock(node.startedAt)}</span>}
          {dur && <span className="text-muted">· {dur}</span>}
        </div>
      </header>
      {/* Tabs with an underline, as in n8n's node details. */}
      <div role="tablist" className="flex gap-5 border-b border-[rgba(255,255,255,0.08)] px-4">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={active === t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 pb-2 text-[13.5px] font-medium transition-colors duration-150 ${
              active === t ? "border-primary text-text" : "border-transparent text-muted hover:text-text"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
        {active === "Output" && <DataTable rows={node.output} empty="No output yet." />}
        {active === "Input" && <DataTable rows={node.input} empty="No input." />}
        {active === "Reasoning" && (
          <ol className="flex flex-col gap-4">
            {node.reasoning.map((r, i) => (
              <li key={i} className="flex gap-3">
                <span className="mt-0.5 w-5 shrink-0 text-right font-mono text-[12px] text-muted">{i + 1}</span>
                <p className="text-[13.5px] leading-[1.55] text-[rgba(237,238,240,0.92)]">{r}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}

function Logs({ logs }: { logs: { at: number; node: string; text: string }[] }) {
  const [open, setOpen] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [logs.length]);
  return (
    <div className="shrink-0 border-t border-[rgba(255,255,255,0.08)] bg-[rgba(10,12,15,0.55)]">
      <button type="button" onClick={() => setOpen(!open)} className="flex h-10 w-full items-center gap-2 px-4 text-[13px]">
        <span className="font-medium text-text">Logs</span>
        <span className="text-muted">{logs.length}</span>
        <IconChevronDown size={14} className="ml-auto text-muted transition-transform duration-300" style={{ transform: open ? "none" : "rotate(180deg)" }} />
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-[400ms]"
        style={{ gridTemplateRows: open ? "1fr" : "0fr", transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)" }}
      >
        <div className="min-h-0 overflow-hidden">
          <div ref={ref} className="scroll-thin h-[132px] overflow-y-auto px-4 pb-3">
            {logs.map((l, i) => (
              <div key={i} className="flex h-7 items-center gap-4 text-[13px]">
                <span className="w-12 shrink-0 font-mono text-[12px] text-muted">{formatClock(l.at)}</span>
                <span className="w-40 shrink-0 truncate text-text">{l.node}</span>
                <span className="truncate text-muted">{l.text}</span>
              </div>
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
        <Logs logs={trace.logs} />
      </section>
      <Details key={node.id} node={node} />
    </motion.div>
  );
}
