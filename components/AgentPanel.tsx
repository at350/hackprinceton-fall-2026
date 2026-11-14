"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { demo } from "@/lib/demo";
import type { AgentStep, ChatMessage } from "@/lib/types";
import { useDash } from "@/lib/useDash";
import { IconArrowUp, IconCheck, IconHand, IconTool, IconX, Spinner } from "./icons";
import { EASE_ENTER, Panel } from "./ui";

function StepRow({ step }: { step: AgentStep }) {
  const color = step.state === "pending" ? "var(--muted)" : "var(--text)";
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: EASE_ENTER }}
      className="flex h-[26px] items-center gap-2.5 text-[13px]"
      style={{ color }}
    >
      <span className="grid size-4 shrink-0 place-items-center">
        {step.state === "done" ? (
          step.kind === "todo" ? (
            <span className="grid size-[14px] place-items-center rounded-full bg-text text-bg">
              <IconCheck size={10} strokeWidth={2.2} />
            </span>
          ) : (
            <IconTool size={14} className="text-muted" />
          )
        ) : step.state === "running" ? (
          <span className="text-primary">
            <Spinner size={14} />
          </span>
        ) : (
          <span className="size-[13px] rounded-full border border-dashed border-line-strong" />
        )}
      </span>
      <span className={`truncate ${step.kind === "tool" ? "text-muted" : ""} ${step.state === "done" && step.kind === "todo" ? "text-muted line-through decoration-line-strong" : ""}`}>
        {step.label}
      </span>
      {step.detail && <span className="ml-auto shrink-0 text-[12px] text-muted">{step.detail}</span>}
    </motion.li>
  );
}

function Steps({ steps }: { steps: AgentStep[] }) {
  const todos = steps.filter((s) => s.kind === "todo");
  const tools = steps.filter((s) => s.kind === "tool");
  const done = todos.filter((s) => s.state === "done").length;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, [steps.length]);
  if (!steps.length) return null;
  return (
    <div className="mx-4 shrink-0 rounded-[12px] border border-line bg-raised px-3 pt-2.5 pb-2">
      <div ref={ref} className="scroll-thin max-h-[118px] overflow-y-auto">
        <ul>
          {todos.map((s) => (
            <StepRow key={s.id} step={s} />
          ))}
        </ul>
        {tools.length > 0 && (
          <ul className="mt-1 border-l border-line pl-3">
            {tools.map((s) => (
              <StepRow key={s.id} step={s} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Message({ m, showLabel }: { m: ChatMessage; showLabel: boolean }) {
  const streaming = m.shown < m.text.length;
  const text = m.text.slice(0, Math.floor(m.shown));
  if (m.role === "medic") {
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: EASE_ENTER }} className="flex justify-end">
        <p className="max-w-[85%] rounded-[12px] rounded-br-[4px] bg-[rgba(255,255,255,0.08)] px-3 py-2 text-[14px] leading-[1.45] text-text">{m.text}</p>
      </motion.div>
    );
  }
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: EASE_ENTER }} className="flex flex-col gap-1.5">
      <p className="text-[14px] leading-[1.5] text-text">
        {text}
        {streaming && <span className="ml-0.5 inline-block h-[14px] w-[2px] translate-y-[2px] bg-primary align-baseline" />}
      </p>
    </motion.div>
  );
}

function Approval() {
  const approval = useDash((s) => s.approval);
  return (
    <AnimatePresence>
      {approval?.state === "pending" && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.45, ease: EASE_ENTER }}
          className="mx-4 mb-3 rounded-[12px] border border-primary bg-[rgba(34,195,230,0.06)] p-3"
        >
          <div className="flex items-center gap-2 text-[13px] font-medium text-primary">
            <IconHand size={15} />
            Needs your approval
          </div>
          <p className="mt-1.5 text-[14px] text-text">{approval.action}</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => demo.resolveApproval(false)}
              className="flex h-11 items-center justify-center gap-2 rounded-[10px] border border-line-strong text-[14px] font-medium text-text transition-colors duration-200 [transition-timing-function:var(--ease-hover)] hover:bg-raised"
            >
              <IconX size={14} />
              Reject
            </button>
            <button
              type="button"
              onClick={() => demo.resolveApproval(true)}
              className="flex h-11 items-center justify-center gap-2 rounded-[10px] bg-primary text-[14px] font-semibold text-bg transition-opacity duration-200 hover:opacity-90"
            >
              <IconCheck size={14} strokeWidth={2} />
              Approve
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Composer() {
  const [text, setText] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        demo.sendMedic(text);
        setText("");
      }}
      className="flex shrink-0 items-center gap-2 border-t border-line p-3"
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Ask the agent"
        aria-label="Message the agent"
        className="h-11 min-w-0 flex-1 rounded-[10px] border border-line bg-raised px-3 text-[14px] text-text outline-none transition-colors duration-200 placeholder:text-muted focus:border-line-strong"
      />
      <button
        type="submit"
        aria-label="Send"
        disabled={!text.trim()}
        className="grid size-11 shrink-0 place-items-center rounded-[10px] bg-text text-bg transition-opacity duration-200 disabled:opacity-30"
      >
        <IconArrowUp size={16} strokeWidth={1.8} />
      </button>
    </form>
  );
}

export function AgentPanel() {
  const steps = useDash((s) => s.steps);
  const messages = useDash((s) => s.messages);
  const approval = useDash((s) => s.approval);
  const busy = messages.some((m) => m.shown < m.text.length) || steps.some((s) => s.state === "running");
  const waiting = approval?.state === "pending";
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const state = waiting
    ? { text: "Waiting for you", el: <IconHand size={13} />, color: "var(--primary)" }
    : busy
      ? { text: "Working", el: <Spinner size={12} />, color: "var(--primary)" }
      : { text: "Idle", el: <span className="size-1.5 rounded-full bg-current" />, color: "var(--muted)" };

  return (
    <Panel
      delay={0.15}
      className="min-h-0 flex-1"
      right={
        <span className="flex items-center gap-1.5 text-[12px] font-medium" style={{ color: state.color }}>
          {state.el}
          {state.text}
        </span>
      }
    >
      <div className="absolute inset-0 flex flex-col">
        <Steps steps={steps} />
        <div ref={scroller} className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
          {messages.length === 0 && (
            <p className="m-auto text-center text-[13px] text-muted">The agent starts when the device connects.</p>
          )}
          {messages.map((m, i) => (
            <Message key={m.id} m={m} showLabel={i === 0 || messages[i - 1].role !== m.role} />
          ))}
        </div>
        <Approval />
        <Composer />
      </div>
    </Panel>
  );
}
