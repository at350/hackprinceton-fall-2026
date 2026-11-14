"use client";

import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { deriveTrace, type TraceLog, type TraceNode } from "@/lib/trace";
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

/** Inspector fields: label above value, no grid, so it can't be mistaken for a log. */
function Fields({ rows, empty }: { rows: [string, string][]; empty: string }) {
  if (!rows.length) return <p className="text-[13px] text-muted">{empty}</p>;
  return (
    <dl className="flex flex-col gap-4">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex flex-col gap-1">
          <dt className="text-[12px] text-muted first-letter:uppercase">{k}</dt>
          <dd className="text-[14px] leading-snug text-text">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Details({ node }: { node: TraceNode }) {
  const tabs = node.kind === "agent" ? (["Reasoning", "Output", "Input"] as const) : (["Output", "Input"] as const);
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
        {active === "Output" && <Fields rows={node.output} empty="No output yet." />}
        {active === "Input" && <Fields rows={node.input} empty="No input." />}
        {active === "Reasoning" && !node.reasoning.length && <p className="text-[13px] text-muted">No reasoning yet.</p>}
        {active === "Reasoning" && node.reasoning.length > 0 && (
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
