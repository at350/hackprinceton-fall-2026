"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { demo } from "@/lib/demo";
import type { AgentStep, ChatMessage } from "@/lib/types";
import { useDash } from "@/lib/useDash";
import { IconArrowUp, IconCheck, IconChevronDown, IconTool, IconX } from "./icons";

// Beautiful UI motion.
const EASE_UI = [0.23, 1, 0.32, 1] as const;

// Which to-do each tool call belongs to.
const PARENT: Record<string, string> = {
  "tool-read": "todo-scan",
  "tool-map": "todo-map",
  "tool-sim": "todo-sims",
  "tool-fit": "todo-rank",
  "tool-alert": "todo-approve",
};

// Waiting: the grid settles into a pause shape (outer columns lit).
const PAUSE = new Set([0, 2, 3, 5, 6, 8]);

/** One status glyph for every state: animates while working, holds a pattern otherwise. */
function DotGrid({ mode }: { mode: "working" | "waiting" | "idle" }) {
  return (
    <span
      className="dot-grid transition-colors duration-300"
      style={{ color: mode === "idle" ? "var(--muted)" : "var(--primary)" }}
      aria-hidden
    >
      {Array.from({ length: 9 }, (_, i) => (
        <span
          key={i}
          style={
            mode === "working"
              ? undefined
              : {
                  animation: "none",
                  opacity: mode === "waiting" ? (PAUSE.has(i) ? 1 : 0.15) : 0.3,
                  transition: "opacity 300ms cubic-bezier(0.23,1,0.32,1)",
                }
          }
        />
      ))}
    </span>
  );
}

// Only the status row animates; plan rows mark the current step without a second loader.
function StepIcon({ step }: { step: AgentStep }) {
  if (step.state === "running")
    return (
      <span className="grid size-[15px] place-items-center rounded-full border-[1.5px] border-primary">
        <span className="size-[5px] rounded-full bg-primary" />
      </span>
    );
  if (step.state === "done")
    return (
      <span className="grid size-[15px] place-items-center rounded-full bg-[rgba(255,255,255,0.14)] text-text">
        <IconCheck size={10} strokeWidth={2.2} />
      </span>
    );
  return <span className="size-[15px] rounded-full border border-[rgba(255,255,255,0.18)]" />;
}

/** Beautiful UI tool-call row: icon, plain action, muted detail chip. */
function ToolRow({ step }: { step: AgentStep }) {
  return (
    <motion.li
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: EASE_UI }}
      className={`flex h-7 items-center gap-2 text-[13px] ${step.state === "running" ? "text-text" : "text-muted"}`}
    >
      <IconTool size={13} className={step.state === "running" ? "text-primary" : ""} />
      <span className="truncate">{step.label}</span>
      {step.detail && (
        <span className="ml-auto shrink-0 rounded-[6px] bg-[rgba(255,255,255,0.06)] px-1.5 py-0.5 font-mono text-[11.5px] text-muted">
          {step.detail}
        </span>
      )}
    </motion.li>
  );
}

/**
 * One status row for the agent: what it is doing right now, which plan step
 * that belongs to, and how long it has been at it. Clicking it opens the plan
 * with tool calls nested under each step (Beautiful UI's thinking disclosure).
 */
function Status() {
  const steps = useDash((s) => s.steps);
  const streaming = useDash((s) => s.messages.some((m) => m.shown < m.text.length));
  const waiting = useDash((s) => s.approval?.state === "pending");
  const t = useDash((s) => Math.floor(s.t / 1000));
  const [open, setOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const todos = steps.filter((s) => s.kind === "todo");
  const tools = steps.filter((s) => s.kind === "tool");
  const done = todos.filter((s) => s.state === "done").length;
  const current = todos.find((s) => s.state === "running");
  const runningTool = [...tools].reverse().find((s) => s.state === "running");
  const busy = !waiting && (streaming || !!current || !!runningTool);
  const label = waiting ? "Waiting for your approval" : runningTool?.label ?? (streaming ? "Writing" : current?.label ?? "Idle");
  const stepNo = current ? todos.indexOf(current) + 1 : done;

  // Elapsed time restarts whenever the agent starts something new.
  const [since, setSince] = useState({ key: "", t });
  const key = busy ? label : "";
  if (since.key !== key || t < since.t) setSince({ key, t });
  const elapsed = t - since.t;

  useEffect(() => {
    const el = scroller.current;
    const row = el?.querySelector<HTMLElement>("[data-active]");
    if (el && row) el.scrollTo({ top: row.offsetTop - 8, behavior: "smooth" });
  }, [current?.id, open]);

  if (!todos.length)
    return (
      <div className="flex h-12 shrink-0 items-center gap-2.5 px-4">
        <DotGrid mode="idle" />
        <span className="text-[13px] text-muted">Starts when the device connects</span>
      </div>
    );

  return (
    <div className="mx-3 mt-3 shrink-0 rounded-[12px] border border-[rgba(255,255,255,0.06)] bg-[rgba(0,0,0,0.18)]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex h-11 w-full items-center gap-2.5 rounded-[12px] px-3 text-left transition-colors duration-100 hover:bg-[rgba(255,255,255,0.03)]"
      >
        <DotGrid mode={waiting ? "waiting" : busy ? "working" : "idle"} />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className={`truncate text-[13px] font-medium ${busy ? "shimmer" : "text-text"}`}>{label}</span>
          <span className="truncate text-[12px] text-muted">
            Step {Math.max(1, stepNo)} of {todos.length}
            {current && ` · ${current.label}`}
          </span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {busy && <span className="font-mono text-[12px] text-muted">{elapsed}s</span>}
          <IconChevronDown
            size={14}
            className="text-muted transition-transform duration-300"
            style={{ transform: open ? "rotate(180deg)" : "none" }}
          />
        </span>
      </button>
      <div
        className="grid transition-[grid-template-rows,opacity] duration-[400ms]"
        style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0, transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)" }}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            ref={scroller}
            className="scroll-thin relative max-h-[168px] overflow-y-auto border-t border-[rgba(255,255,255,0.06)] px-3 pt-1.5 pb-3"
            style={{ maskImage: "linear-gradient(to bottom, black calc(100% - 20px), transparent)", WebkitMaskImage: "linear-gradient(to bottom, black calc(100% - 20px), transparent)" }}
          >
            <ul>
              {todos.map((todo) => {
                const kids = tools.filter((x) => PARENT[x.id] === todo.id);
                const isActive = todo.state === "running";
                return (
                  <li key={todo.id} data-active={isActive || undefined}>
                    <div className={`flex h-7 items-center gap-2.5 text-[13px] ${todo.state === "pending" ? "text-muted" : "text-text"}`}>
                      <StepIcon step={todo} />
                      <span className="truncate">{todo.label}</span>
                    </div>
                    {kids.length > 0 && todo.state !== "pending" && (
                      <ul className="ml-[7px] border-l border-[rgba(255,255,255,0.08)] pl-4">
                        {kids.map((k) => (
                          <ToolRow key={k.id} step={k} />
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Streams word by word with a slim cursor. */
function Message({ m }: { m: ChatMessage }) {
  const streaming = m.shown < m.text.length;
  let text = m.text;
  if (streaming) {
    const cut = m.text.lastIndexOf(" ", Math.floor(m.shown));
    text = m.text.slice(0, Math.max(0, cut));
  }
  if (m.role === "medic") {
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: EASE_UI }} className="flex justify-end">
        <p className="max-w-[85%] rounded-[14px] bg-[rgba(255,255,255,0.08)] px-3 py-2 text-[13.5px] leading-[1.5] text-text">{m.text}</p>
      </motion.div>
    );
  }
  return (
    <motion.p
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: EASE_UI }}
      className="text-[13.5px] leading-[1.6] text-[rgba(237,238,240,0.92)]"
    >
      {text}
      {streaming && <span className="ml-0.5 inline-block h-[13px] w-[1.5px] translate-y-[2px] bg-text" />}
    </motion.p>
  );
}

/** Beautiful UI approval card, inline when the agent pauses. */
function Approval() {
  const approval = useDash((s) => s.approval);
  return (
    <AnimatePresence>
      {approval?.state === "pending" && (
        <motion.div
          initial={{ opacity: 0, y: 10, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6 }}
          transition={{ duration: 0.38, ease: EASE_UI }}
          className="mx-3 mb-2 rounded-[14px] border border-[rgba(255,255,255,0.08)] bg-[rgba(8,10,13,0.7)] p-3.5"
        >
          <p className="text-[14px] font-medium text-text">Send pre-alert to the trauma center?</p>
          <p className="mt-1 text-[13px] leading-[1.5] text-muted">Includes the map, best fit (epidural, L temporal, 22 mL) and the scan log.</p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => demo.resolveApproval(false)}
              className="flex h-10 items-center gap-1.5 rounded-[10px] px-4 text-[13.5px] font-medium text-text transition-colors duration-100 hover:bg-[rgba(255,255,255,0.06)] active:scale-[0.97]"
            >
              <IconX size={13} />
              Reject
            </button>
            <button
              type="button"
              onClick={() => demo.resolveApproval(true)}
              className="flex h-10 items-center gap-1.5 rounded-[10px] bg-primary px-5 text-[13.5px] font-semibold text-[#04141a] transition-transform duration-150 active:scale-[0.97]"
            >
              <IconCheck size={13} strokeWidth={2.2} />
              Approve
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Beautiful UI prompt bar: inset rounded field, 28px send button. */
function Composer() {
  const [text, setText] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        demo.sendMedic(text);
        setText("");
      }}
      className="mx-3 mb-3 flex shrink-0 items-center gap-1.5 rounded-[14px] border border-[rgba(255,255,255,0.08)] bg-[rgba(0,0,0,0.22)] p-1.5 pl-3 transition-colors duration-150 focus-within:border-[rgba(255,255,255,0.18)]"
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Ask about this scan"
        aria-label="Message the agent"
        className="h-9 min-w-0 flex-1 bg-transparent text-[13.5px] text-text outline-none placeholder:text-muted"
      />
      <button
        type="submit"
        aria-label="Send"
        disabled={!text.trim()}
        className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-text text-bg transition-[opacity,transform] duration-150 active:scale-[0.94] disabled:opacity-25"
      >
        <IconArrowUp size={15} strokeWidth={1.8} />
      </button>
    </form>
  );
}

export function AgentPanel() {
  const messages = useDash((s) => s.messages);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.08, 0.78, 0.56, 1], delay: 0.15 }}
      className="surface raised flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <Status />
      <div
        ref={scroller}
        className="scroll-thin mt-2 flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 pt-4 pb-3"
        style={{
          maskImage: "linear-gradient(to bottom, transparent 0, transparent 10px, black 40px)",
          WebkitMaskImage: "linear-gradient(to bottom, transparent 0, transparent 10px, black 40px)",
        }}
      >
        {messages.map((m) => (
          <Message key={m.id} m={m} />
        ))}
      </div>
      <Approval />
      <Composer />
    </motion.section>
  );
}
