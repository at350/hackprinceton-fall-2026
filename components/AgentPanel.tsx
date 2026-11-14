"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { demo } from "@/lib/demo";
import { type BadgeKey, type HandoffStep, type Tone, clockTime, handoffBadge, handoffSteps, lastFour } from "@/lib/handoff";
import { LIVE } from "@/lib/live";
import type { AgentStep, CallEntry, ChatMessage, Handoff } from "@/lib/types";
import { useDash } from "@/lib/useDash";
import {
  IconAlert,
  IconArrowUp,
  IconChat,
  IconCheck,
  IconChecks,
  IconChevronDown,
  IconClock,
  IconEye,
  IconFlask,
  IconInfo,
  IconPhone,
  IconPhoneOutgoing,
  IconPhoneX,
  IconQuestion,
  IconSent,
  IconTool,
  IconUserCheck,
  IconUserMinus,
  IconX,
  IconXCircle,
} from "./icons";

// Beautiful UI motion.
const EASE_UI = [0.23, 1, 0.32, 1] as const;

// Which to-do each tool call belongs to, when the step does not say (demo mode).
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
  // Live mode: the run has begun but the agent has not written its plan yet.
  const starting = useDash((s) => LIVE && s.device === "scanning");
  const [open, setOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const todos = steps.filter((s) => s.kind === "todo");
  const tools = steps.filter((s) => s.kind === "tool");
  const done = todos.filter((s) => s.state === "done").length;
  const current = todos.find((s) => s.state === "running");
  const runningTool = [...tools].reverse().find((s) => s.state === "running");
  const busy = !waiting && (streaming || !!current || !!runningTool);
  const rescan = useDash((s) => s.approval?.approveLabel === "Re-scanned");
  const label = waiting ? (rescan ? "Waiting for the re-scan" : "Waiting for your approval") : runningTool?.label ?? (streaming ? "Writing" : current?.label ?? "Idle");
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
        <DotGrid mode={starting ? "working" : "idle"} />
        <span className="text-[13px] text-muted">
          {starting ? "Starting" : LIVE ? "Starts when you run a scan" : "Starts when the device connects"}
        </span>
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
                const kids = tools.filter((x) => (x.parent ?? PARENT[x.id]) === todo.id);
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

// ---- Hand-off (live mode) -------------------------------------------------

const TONE: Record<Tone, string> = { text: "var(--text)", primary: "var(--primary)", warn: "var(--bleed-text)", muted: "var(--muted)" };

const BADGE_ICON: Record<BadgeKey, typeof IconSent> = {
  simulated: IconFlask,
  sent: IconSent,
  delivered: IconChecks,
  read: IconEye,
  failed: IconAlert,
  no_one_on_call: IconUserMinus,
  accepted: IconUserCheck,
  declined: IconXCircle,
  calling: IconPhoneOutgoing,
  on_call: IconPhone,
  no_answer: IconPhoneX,
  call_failed: IconPhoneX,
  no_reply: IconClock,
};

/** QualityBadge's pill: icon and label, coloured only when it matters. */
function Badge({ icon: Icon, label, tone }: { icon: typeof IconSent; label: string; tone: Tone }) {
  return (
    <span
      className="inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-line px-2.5 text-[12px] font-medium"
      style={{ color: TONE[tone] }}
    >
      <Icon size={13} />
      {label}
    </span>
  );
}

function HandoffStepIcon({ state }: { state: HandoffStep["state"] }) {
  if (state === "failed")
    return (
      <span className="grid size-[15px] shrink-0 place-items-center rounded-full bg-[rgba(255,148,121,0.16)] text-bleed-text">
        <IconX size={9} strokeWidth={2.2} />
      </span>
    );
  return <StepIcon step={{ id: "", kind: "todo", label: "", state }} />;
}

function handoffTitle(h: Handoff) {
  if (h.status === "no_one_on_call") return { title: "Pre-alert not sent", sub: "Hand off by radio" };
  const sent = clockTime(h.sent_at);
  const what = h.kind === "update" ? "Update" : "Pre-alert";
  return {
    title: h.to ? `${what} to ${lastFour(h.to)}` : what,
    sub: h.simulated ? "Simulated · no hospital link yet" : `iMessage${sent ? ` · sent ${sent}` : ""}`,
  };
}

/**
 * The pre-alert once it has gone out: a second row under the agent's, in the
 * same shape. Collapsed it names the recipient and the furthest status; open it
 * lists sent, delivered, the reply and the call, like the plan.
 */
function HandoffRow() {
  const handoff = useDash((s) => s.handoff);
  const [open, setOpen] = useState(false);
  if (!handoff) return null;
  const badge = handoffBadge(handoff);
  const steps = handoffSteps(handoff);
  const { title, sub } = handoffTitle(handoff);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: EASE_UI }}
      className="mx-3 mt-2 shrink-0 rounded-[12px] border border-[rgba(255,255,255,0.06)] bg-[rgba(0,0,0,0.18)]"
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex h-11 w-full items-center gap-2.5 rounded-[12px] px-3 text-left transition-colors duration-100 hover:bg-[rgba(255,255,255,0.03)]"
      >
        <IconChat size={16} className="shrink-0 text-primary" />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[13px] font-medium text-text">{title}</span>
          <span className="truncate text-[12px] text-muted">{sub}</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <Badge icon={BADGE_ICON[badge.key]} label={badge.label} tone={badge.tone} />
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
          <ul className="border-t border-[rgba(255,255,255,0.06)] px-3 pt-1.5 pb-3">
            {steps.map((step) => (
              <li key={step.id} className={`flex h-7 items-center gap-2.5 text-[13px] ${step.state === "pending" ? "text-muted" : "text-text"}`}>
                <HandoffStepIcon state={step.state} />
                <span className="truncate">{step.label}</span>
                {step.detail && (
                  <span className="ml-auto shrink-0 rounded-[6px] bg-[rgba(255,255,255,0.06)] px-1.5 py-0.5 font-mono text-[11.5px] text-muted">
                    {step.detail}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </motion.div>
  );
}

// ---- Chat -----------------------------------------------------------------

const ENTER = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.3, ease: EASE_UI } };

/** A text from the receiving clinician: a hairline bubble on the left, under who sent it. */
function ClinicianMessage({ m }: { m: ChatMessage }) {
  return (
    <motion.div {...ENTER} className="flex flex-col items-start gap-1.5">
      <p className="flex items-center gap-1.5 text-[12px] leading-none text-muted">
        <IconChat size={13} />
        Receiving clinician · iMessage
      </p>
      <p className="max-w-[85%] rounded-[14px] border border-[rgba(255,255,255,0.14)] px-3 py-2 text-[13.5px] leading-[1.5] text-text">{m.text}</p>
    </motion.div>
  );
}

/** A hand-off channel event is not a person: one muted line with an icon. */
function ChannelEvent({ m }: { m: ChatMessage }) {
  const Icon = /not answered|no answer/i.test(m.text)
    ? IconPhoneX
    : /call/i.test(m.text)
      ? IconPhoneOutgoing
      : /could not|not delivered|failed|nobody|no one/i.test(m.text)
        ? IconAlert
        : IconInfo;
  return (
    <motion.p {...ENTER} className="flex items-start gap-2 text-[13px] leading-[1.5] text-muted">
      <Icon size={14} className="mt-[3px] shrink-0" />
      {m.text}
    </motion.p>
  );
}

const CALL_DECISION: Record<CallEntry["decision"], { icon: typeof IconSent; label: string; tone: Tone }> = {
  accept: { icon: IconUserCheck, label: "Accepted", tone: "primary" },
  decline: { icon: IconXCircle, label: "Declined", tone: "warn" },
  none: { icon: IconQuestion, label: "No decision", tone: "muted" },
};

/** A phone call with the clinician: decision and summary, the transcript folded. */
function CallMessage({ m }: { m: ChatMessage }) {
  const call = useDash((s) => s.handoff?.call);
  const [open, setOpen] = useState(false);
  const entry = m.call ?? { decision: "none" as const, summary: m.text, transcript: "" };
  const decision = CALL_DECISION[entry.decision];
  const summary = entry.summary || call?.summary || "";
  const secs = call?.duration_s;
  return (
    <motion.div {...ENTER} className="max-w-[92%] rounded-[14px] border border-[rgba(255,255,255,0.14)] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <IconPhone size={14} className="shrink-0" />
        <span className="text-[13.5px] font-medium text-text">Phone call</span>
        {secs ? <span className="font-mono text-[12px] text-muted">{`${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, "0")}`}</span> : null}
        <span className="ml-auto">
          <Badge icon={decision.icon} label={decision.label} tone={decision.tone} />
        </span>
      </div>
      {summary && <p className="mt-1.5 text-[13.5px] leading-[1.5] text-text">{summary}</p>}
      {entry.transcript && (
        <>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="mt-2 flex items-center gap-1.5 text-[12.5px] font-medium text-muted transition-colors duration-100 hover:text-text"
          >
            Transcript
            <IconChevronDown size={12} className="transition-transform duration-300" style={{ transform: open ? "rotate(180deg)" : "none" }} />
          </button>
          <div
            className="grid transition-[grid-template-rows,opacity] duration-[400ms]"
            style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0, transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)" }}
          >
            <p className="min-h-0 overflow-hidden whitespace-pre-line text-[13px] leading-[1.5] text-[rgba(237,238,240,0.92)]">
              <span className="block pt-2">{entry.transcript}</span>
            </p>
          </div>
        </>
      )}
    </motion.div>
  );
}

/** Streams word by word with a slim cursor. */
function Message({ m }: { m: ChatMessage }) {
  if (m.role === "clinician") return <ClinicianMessage m={m} />;
  if (m.role === "event") return <ChannelEvent m={m} />;
  if (m.role === "call") return <CallMessage m={m} />;
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
  if (m.relayed && !streaming)
    return (
      <motion.div {...ENTER} className="flex flex-col gap-1.5">
        <p className="text-[13.5px] leading-[1.6] text-[rgba(237,238,240,0.92)]">{text}</p>
        <p className="flex items-center gap-1.5 text-[12px] leading-none text-muted">
          <IconChecks size={13} />
          Sent to the clinician by iMessage
        </p>
      </motion.div>
    );
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
          <p className="text-[14px] font-medium text-text">{approval.title ?? approval.action}</p>
          {approval.detail && <p className="mt-1 text-[13px] leading-[1.5] text-muted">{approval.detail}</p>}
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => demo.resolveApproval(false)}
              className="flex h-10 items-center gap-1.5 rounded-[10px] px-4 text-[13.5px] font-medium text-text transition-colors duration-100 hover:bg-[rgba(255,255,255,0.06)] active:scale-[0.97]"
            >
              <IconX size={13} />
              {approval.rejectLabel ?? "Reject"}
            </button>
            <button
              type="button"
              onClick={() => demo.resolveApproval(true)}
              className="flex h-10 items-center gap-1.5 rounded-[10px] bg-primary px-5 text-[13.5px] font-semibold text-[#04141a] transition-transform duration-150 active:scale-[0.97]"
            >
              <IconCheck size={13} strokeWidth={2.2} />
              {approval.approveLabel ?? "Approve"}
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

const FADE = "linear-gradient(to bottom, transparent 0, black 24px)";

export function AgentPanel() {
  const messages = useDash((s) => s.messages);
  const asking = useDash((s) => s.approval?.state === "pending");
  const scroller = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setClipped(el.scrollTop > 4);
    // Also when the approval card opens: it takes room from the bottom of the list.
  }, [messages, asking]);

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.08, 0.78, 0.56, 1], delay: 0.15 }}
      className="surface raised flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <Status />
      <HandoffRow />
      <div
        ref={scroller}
        onScroll={(e) => setClipped(e.currentTarget.scrollTop > 4)}
        className="scroll-thin mt-2 flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 pt-4 pb-3"
        // Fade the top edge only when earlier messages are scrolled out of view.
        style={clipped ? { maskImage: FADE, WebkitMaskImage: FADE } : undefined}
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
