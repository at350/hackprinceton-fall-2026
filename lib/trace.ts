import { demo } from "./demo";
import { lastFour } from "./handoff";
import { LIVE } from "./live";
import type { AgentStep, DashState, Handoff, RegionName, ScanSpot, ScanStatus, Simulation, StepState } from "./types";

// The agent run as a graph: the main pipeline left to right, and the triage
// agent's model, memory, tools and region sub-agents attached underneath it.

export type TraceStatus = "idle" | "running" | "waiting" | "success" | "error";
export type TraceKind = "trigger" | "step" | "agent" | "wait" | "action" | "model" | "memory" | "tool" | "subagent";

/**
 * The inspector's one big thing: a statement in the dashboard's verdict style,
 * or a picture where the answer is a place on the head.
 */
export type TraceHero =
  | { kind: "verdict"; status: ScanStatus }
  | { kind: "statement"; text: string; tone?: "primary" | "bleed"; icon?: "check" | "x" | "anthropic"; size?: "question" }
  | { kind: "number"; label: string; value: string }
  | { kind: "spots"; map: number[][] | null; spots: ScanSpot[]; current: number | null; weak: number[] }
  | { kind: "fit"; map: number[][]; label: string; value: string };

export interface TracePlanStep {
  id: string;
  label: string;
  state: StepState;
  tools: { id: string; label: string; detail?: string; running: boolean }[];
}

/** The one fold a panel may have, closed by default. */
export type TraceFold =
  | { kind: "plan"; title: string; count: string; waiting: boolean; steps: TracePlanStep[] }
  | { kind: "hypotheses"; title: string; count: string; items: { id: string; label: string; score: number | null; best: boolean }[] }
  // Live mode: the clinician's texts with Lucid's answers, or a call's transcript.
  | { kind: "messages"; title: string; count: string; items: { id: string; who: string; text: string }[] };

export interface TracePanel {
  status?: string; // replaces the generic status label
  hero: TraceHero | null;
  sentence: string;
  quiet?: boolean; // the node has not run: the sentence says what it waits for
  actions?: boolean; // approve and reject, while the medic is asked
  fold?: TraceFold;
}

export interface TraceNode {
  id: string;
  kind: TraceKind;
  title: string;
  subtitle: string;
  status: TraceStatus;
  startedAt: number | null; // demo ms
  endedAt: number | null;
  items: number | null; // items produced so far
  panel: TracePanel;
}

export interface TraceEdge {
  from: string;
  to: string;
  kind: "main" | "ai";
  // A node with two outputs (n8n's If): which one, and its label.
  port?: 0 | 1;
  label?: string;
  items?: number | null; // items on this edge, when not the source node's count
}

export interface TraceLog {
  at: number; // demo ms
  nodeId: string;
  node: string;
  text: string;
}

export interface Trace {
  nodes: TraceNode[];
  edges: TraceEdge[];
  logs: TraceLog[];
}

const MAIN = ["device", "spots", "map", "agent", "rank", "approval", "alert"];
const REGION_IDS: RegionName[] = ["frontal", "temporal", "parietal", "occipital"];
const TYPE = { epidural: "Epidural", subdural: "Subdural", intraparenchymal: "Intraparenchymal" };
// Which to-do each tool call belongs to when the step does not say (demo mode), as in AgentPanel.
const PARENT: Record<string, string> = {
  "tool-read": "todo-scan",
  "tool-map": "todo-map",
  "tool-sim": "todo-sims",
  "tool-fit": "todo-rank",
  "tool-alert": "todo-approve",
};

const node = (n: Omit<TraceNode, "status" | "startedAt" | "endedAt" | "items"> & Partial<TraceNode>): TraceNode => ({
  status: "idle",
  startedAt: null,
  endedAt: null,
  items: null,
  ...n,
});

// ---- The hand-off (live mode) ----
// Times stay out of the panels, as everywhere in the inspector; the status row in
// the agent panel carries them.

const delivered = (h: Handoff) => h.status === "delivered" || h.status === "read";

/** Send pre-alert once something went out: the pre-alert, or on a later scan the update. */
function handoffAlert(h: Handoff): TraceNode {
  const to = h.to ? lastFour(h.to) : "";
  const update = h.kind === "update";
  const base = { id: "alert", kind: "action" as const, title: update ? "Send update" : "Send pre-alert" };
  if (h.status === "no_one_on_call")
    return node({
      ...base,
      subtitle: "No one on call",
      status: "error",
      panel: { status: "No one on call", hero: { kind: "statement", text: "Not sent", tone: "bleed", icon: "x" }, sentence: "Nobody is on call, so the medic hands off by radio." },
    });
  if (h.status === "failed")
    return node({
      ...base,
      subtitle: `iMessage · ${to}`,
      status: "error",
      panel: { status: "Not delivered", hero: { kind: "statement", text: "Not delivered", tone: "bleed", icon: "x" }, sentence: `The ${update ? "update" : "pre-alert"} could not reach ${to}, so the medic hands off by radio.` },
    });
  if (h.simulated)
    return node({
      ...base,
      subtitle: "Simulated",
      status: "success",
      items: 1,
      panel: { status: "Simulated", hero: { kind: "statement", text: "Simulated" }, sentence: "There is no hospital link in this build, so nothing left the device." },
    });
  const arrived = delivered(h) ? " It was delivered." : " Delivery is not confirmed yet.";
  return node({
    ...base,
    subtitle: `iMessage · ${to}`,
    status: "success",
    items: 1,
    panel: update
      ? { hero: { kind: "statement", text: "Update sent", tone: "primary", icon: "check" }, sentence: `The clinician who accepted this patient, ${to}, was texted what changed since the first scan.${arrived}` }
      : { hero: { kind: "statement", text: "Pre-alert sent", tone: "primary", icon: "check" }, sentence: `The map and the pre-alert went to ${to} by iMessage.${arrived}` },
  });
}

/** "Name: words" lines of a call transcript as speaker turns. */
function transcriptTurns(text: string) {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => {
      const m = /^([A-Za-z][\w .]{0,24}):\s*(.+)$/.exec(line);
      return { id: `t${i}`, who: m ? m[1] : "", text: m ? m[2] : line };
    });
}

/**
 * Clinician reply (waits for a text; outputs "reply" and "no reply"), Phone call,
 * Hand-off decision. On a later scan that only sent an update, none of them waits:
 * the decision stands from the first scan.
 */
function handoffNodes(s: DashState, h: Handoff | null | undefined): { nodes: TraceNode[]; edges: TraceEdge[] } {
  const update = h?.kind === "update";
  const open = !!h && !h.simulated && h.status !== "failed" && h.status !== "no_one_on_call" && !update;
  const to = h?.to ? lastFour(h.to) : "the clinician";
  const reply = h?.reply ?? null;
  const call = h?.call ?? null;
  const byText = !!reply && reply.via !== "call";
  const accepted = reply?.decision === "accept";

  // Each clinician text and the answer Lucid sent back.
  const exchange: { id: string; who: string; text: string }[] = [];
  s.messages.forEach((m, i) => {
    if (m.role !== "clinician") return;
    exchange.push({ id: m.id, who: "Clinician", text: m.text });
    const answer = s.messages.slice(i + 1).find((x) => x.role !== "agent" || x.relayed);
    if (answer?.role === "agent") exchange.push({ id: answer.id, who: "Lucid", text: answer.text });
  });
  const texts = exchange.filter((x) => x.who === "Clinician").length;
  const messages: TraceFold | undefined = exchange.length ? { kind: "messages", title: "Messages", count: `${texts} from the clinician`, items: exchange } : undefined;
  const callMsg = [...s.messages].reverse().find((m) => m.role === "call")?.call;

  const replyNode = node({
    id: "reply",
    kind: "wait",
    title: "Clinician reply",
    subtitle: open ? `iMessage · ${to}` : "Waits for a text",
    status: !open ? "idle" : reply || call || h?.no_reply_at ? "success" : "waiting",
    items: open && (reply || call) ? Math.max(1, texts) : texts || null,
    panel: update
      ? { hero: null, sentence: "No reply needed: the clinician already accepted this patient.", quiet: true }
      : !open
        ? { hero: null, sentence: "Waits for the clinician once the pre-alert is out.", quiet: true }
        : byText
          ? {
              hero: { kind: "statement", text: accepted ? "Accepted" : "Declined", tone: accepted ? "primary" : "bleed", icon: accepted ? "check" : "x" },
              sentence: `The clinician ${accepted ? "accepted" : "declined"} by text${texts > 1 ? ` after ${texts === 2 ? "a question" : `${texts - 1} questions`}` : ""}.`,
              fold: messages,
            }
          : call || h?.no_reply_at
            ? { status: "No reply", hero: { kind: "statement", text: "No reply", tone: "bleed", icon: "x" }, sentence: call ? "No decision came by text in time, so Lucid phoned them." : "No decision came by text in time, so Lucid told the medic.", fold: messages }
            : {
                status: "Waiting for reply",
                hero: { kind: "statement", text: "Waiting for a reply", size: "question" },
                sentence: texts ? `They asked ${texts === 1 ? "a question" : `${texts} questions`}, and Lucid answered from the scan.` : delivered(h!) ? "The pre-alert was delivered; no reply yet." : "The pre-alert is on its way.",
                fold: messages,
              },
  });

  const turns = callMsg?.transcript ? transcriptTurns(callMsg.transcript) : [];
  const transcript: TraceFold | undefined = turns.length ? { kind: "messages", title: "Transcript", count: `${turns.length} turns`, items: turns } : undefined;
  const callDecision = callMsg?.decision === "accept" ? "Accepted" : callMsg?.decision === "decline" ? "Declined" : "Answered";
  const callNode = node({
    id: "call",
    kind: "action",
    title: "Phone call",
    subtitle: !call ? "If no reply" : call.status === "ringing" ? "Ringing" : call.status === "answered" ? "Answered" : call.status === "no_answer" ? "No answer" : "Failed",
    status: !call ? "idle" : call.status === "ringing" ? "running" : call.status === "answered" ? "success" : "error",
    items: call?.status === "answered" ? 1 : null,
    panel: !call
      ? { hero: null, sentence: update ? "Not needed on an update." : "Rings the clinician if no decision comes by text.", quiet: true }
      : call.status === "ringing"
        ? { status: "Ringing", hero: { kind: "statement", text: "Ringing", size: "question" }, sentence: `Lucid is phoning ${to}.` }
        : call.status === "answered"
          ? {
              hero: { kind: "statement", text: callDecision, tone: callDecision === "Declined" ? "bleed" : "primary", icon: callDecision === "Declined" ? "x" : "check" },
              sentence: callMsg?.summary || call.summary || "The clinician answered the call.",
              fold: transcript,
            }
          : { status: call.status === "no_answer" ? "No answer" : "Failed", hero: { kind: "statement", text: call.status === "no_answer" ? "No answer" : "Call failed", tone: "bleed", icon: "x" }, sentence: "Lucid told the medic to hand off by radio." },
  });

  const decision = node({
    id: "decision",
    kind: "step",
    title: "Hand-off decision",
    subtitle: reply ? `${accepted ? "Accepted" : "Declined"}${update ? " · first scan" : reply.via === "call" ? " by call" : " by text"}` : "Accept or decline",
    status: !reply ? "idle" : accepted ? "success" : "error",
    items: reply ? 1 : null,
    panel: !reply
      ? { hero: null, sentence: "Records the clinician's accept or decline.", quiet: true }
      : {
          status: update ? "First scan" : accepted ? undefined : "Declined",
          hero: { kind: "statement", text: accepted ? "Accepted" : "Declined", tone: accepted ? "primary" : "bleed", icon: accepted ? "check" : "x" },
          sentence: update
            ? `The clinician ${accepted ? "accepted" : "declined"} this patient on the first scan; this scan only told them what changed.`
            : `The clinician ${accepted ? "accepted" : "declined"} ${reply.via === "call" ? "on the phone" : "by text"}${reply.note && reply.note.length <= 80 ? `: “${reply.note}”` : ""}.`,
        },
  });

  const edges: TraceEdge[] = [
    { from: "alert", to: "reply", kind: "main", ...(open ? {} : { items: null }) },
    { from: "reply", to: "decision", kind: "main", port: 0, label: "reply", items: byText && !update ? 1 : null },
    { from: "reply", to: "call", kind: "main", port: 1, label: "no reply", items: call ? 1 : null },
    { from: "call", to: "decision", kind: "main", items: reply?.via === "call" && !update ? 1 : null },
  ];
  return { nodes: [replyNode, callNode, decision], edges };
}

function span(t: number, start: number, end: number | null): Pick<TraceNode, "status" | "startedAt" | "endedAt"> {
  if (t < start) return { status: "idle", startedAt: null, endedAt: null };
  if (end === null || t < end) return { status: "running", startedAt: start, endedAt: null };
  return { status: "success", startedAt: start, endedAt: end };
}

const best = (sims: Simulation[]) =>
  sims.filter((x) => x.status === "done").reduce<Simulation | null>((a, b) => (!a || b.score > a.score ? b : a), null);

// Non-breaking spaces keep "22 mL" and "L temporal" on one line.
const ml = (v: number) => `${v}\u00a0mL`;
const place = (region: string) => region.replace(/^([LR]) /, "$1\u00a0");
const hypothesis = (x: Simulation) => `${TYPE[x.type]}, ${place(x.region)}, ${ml(x.volume_ml)}`;

function plan(steps: AgentStep[], waiting: boolean): TraceFold | undefined {
  const todos = steps.filter((x) => x.kind === "todo");
  if (!todos.length) return undefined;
  const tools = steps.filter((x) => x.kind === "tool");
  return {
    kind: "plan",
    title: "Plan",
    count: `${todos.filter((x) => x.state === "done").length} of ${todos.length} steps`,
    waiting,
    steps: todos.map((todo) => ({
      id: todo.id,
      label: todo.label,
      state: todo.state,
      // Tool calls show once their step has started.
      tools:
        todo.state === "pending"
          ? []
          : tools
              .filter((x) => (x.parent ?? PARENT[x.id]) === todo.id && x.state !== "pending")
              .map((x) => ({ id: x.id, label: x.label, detail: x.detail, running: x.state === "running" })),
    })),
  };
}

export function deriveTrace(s: DashState): Trace {
  const t = s.t;
  const T = demo.timeline;
  const spotsDone = s.spots.filter((p) => p.state === "done").length;
  const done = s.sims.filter((x) => x.status === "done");
  const simsDone = done.length;
  const top = best(s.sims);
  const scan = s.scan;
  const approval = s.approval;
  // Every spot visited (a weak-contact spot counts as read).
  const scanned = s.spots.every((p) => p.state === "done" || p.state === "rescan");
  // Live mode: no result is stated until the medic approves it.
  const stated = scan !== null && scan.status !== "pending" && scan.status !== "rejected";
  const alertSent = T.alertSent ?? approval?.state === "approved";
  const ranked = t >= T.simEnd + 300 && top !== null;
  const rescanAsk = approval?.approveLabel === "Re-scanned";

  // ---- Main pipeline ----

  const deviceUp = s.device === "connected" || s.device === "scanning";
  const device = node({
    id: "device",
    kind: "trigger",
    title: "Lucid device",
    subtitle: "USB serial · 50 Hz",
    ...(s.device === "disconnected"
      ? { status: "idle", startedAt: null, endedAt: null }
      : s.device === "connecting"
        ? { status: "running", startedAt: 0, endedAt: null }
        : { status: "success", startedAt: 0, endedAt: T.connectedAt }),
    items: deviceUp ? 1 : null,
    panel: deviceUp
      ? {
          hero: { kind: "statement", text: "Connected" },
          sentence: s.quality === "good" ? "The device is on and the signal is good." : s.quality === "weak" ? "The device is on, but the signal is weak." : "The device is on, but the coil has no contact.",
        }
      : s.device === "connecting"
        ? { hero: null, sentence: "Connecting to the device." }
        : { hero: null, sentence: "Waiting for the device to connect.", quiet: true },
  });

  // A spot marked for a re-scan, or one the live reading flags as weak contact.
  const weak = s.spots
    .filter((p) => p.state === "rescan" || s.reading?.spots.find((r) => r.index === p.index)?.quality === "weak")
    .map((p) => p.index);
  const highest = s.spots.reduce<ScanSpot | null>((a, p) => (p.peak !== null && (!a || p.peak > a.peak!) ? p : a), null);
  const current = s.currentSpot === null ? null : s.spots[s.currentSpot];
  const spotsSpan = span(t, T.scanAt, scanned ? T.scanEnd : null);
  const spots = node({
    id: "spots",
    kind: "step",
    title: "Read scan spots",
    subtitle: "8 spots around the head",
    ...spotsSpan,
    items: spotsDone || null,
    panel:
      spotsSpan.status === "idle"
        ? { hero: null, sentence: "Starts when the device is on the first spot.", quiet: true }
        : {
            hero: { kind: "spots", map: scan?.map ?? null, spots: s.spots, current: s.currentSpot, weak },
            sentence:
              spotsSpan.status === "success"
                ? `All 8 spots read${highest ? `; ${place(highest.name)} reads highest` : ""}.`
                : current
                  ? `${spotsDone} of 8 spots read; now on ${place(current.name)}.`
                  : `${spotsDone} of 8 spots read.`,
          },
  });

  const mapSpan = span(t, T.firstMapAt, scanned ? T.scanEnd : null);
  const where = stated && scan.region && scan.region !== "None" ? `, peaking at ${place(scan.region)}${scan.volume_ml ? `, about ${ml(scan.volume_ml)}` : ""}` : "";
  const map = node({
    id: "map",
    kind: "step",
    title: "Build likelihood map",
    subtitle: "64 × 64 grid",
    ...mapSpan,
    items: scan ? 1 : null,
    panel: !scan
      ? { hero: null, sentence: "Starts once the first spot is read.", quiet: true }
      : scan.status === "rejected"
        ? { hero: { kind: "verdict", status: "rejected" }, sentence: "The medic rejected the proposed result." }
        : {
            hero: scan.status === "pending" ? null : { kind: "verdict", status: scan.status },
            sentence: `Built from ${spotsDone === 8 ? "all 8" : `${spotsDone} of 8`} spots${where}.`,
          },
  });

  // ---- Triage agent ----

  const todos = s.steps.filter((x) => x.kind === "todo");
  const agentRunning = s.steps.some((x) => x.state === "running");
  const waiting = approval?.state === "pending";
  const agentStatus: TraceStatus = waiting ? "waiting" : agentRunning ? "running" : s.steps.length ? "success" : "idle";
  const finding =
    stated && scan.status === "bleed"
      ? `${top && top.region === scan.region ? `${TYPE[top.type]} bleed` : "Bleed"} at ${place(scan.region)}${scan.volume_ml ? `, about ${ml(scan.volume_ml)}` : ""}.`
      : null;
  const tested = simsDone ? `Tested ${simsDone} bleed hypotheses with ${new Set(done.map((x) => x.agent)).size} region agents.` : null;
  const runningTodo = todos.find((x) => x.state === "running");
  const runningTool = [...s.steps].reverse().find((x) => x.kind === "tool" && x.state === "running");
  const simulating = s.agents.filter((a) => a.state === "running").length;
  // After a live rejection the scan stays pending: nothing was recorded.
  const verdict: ScanStatus | null = !scan ? null : scan.status === "pending" ? (approval?.state === "rejected" ? "rejected" : null) : scan.status;
  const agentPanel: TracePanel =
    agentStatus === "idle"
      ? { hero: null, sentence: LIVE ? (s.device === "scanning" ? "Starting." : "Starts when you run a scan.") : "Starts when the device connects.", quiet: true }
      : agentStatus === "running"
        ? {
            hero: runningTodo ? { kind: "statement", text: runningTodo.label, size: "question" } : null,
            sentence: simulating
              ? `${simulating} region ${simulating === 1 ? "agent is" : "agents are"} testing ${s.sims.length} bleed hypotheses.`
              : runningTool
                ? `${runningTool.label}${runningTool.detail ? `, ${runningTool.detail}` : ""}.`
                : `On step ${todos.indexOf(runningTodo!) + 1} of ${todos.length}.`,
          }
        : {
            hero: stated ? { kind: "verdict", status: scan.status } : waiting ? { kind: "statement", text: approval.title ?? approval.action, size: "question" } : verdict ? { kind: "verdict", status: verdict } : null,
            sentence: finding ?? (waiting && top && !stated ? `${TYPE[top.type]} bleed at ${place(top.region)}, about ${ml(top.volume_ml)}, fits best.` : tested ?? "The run is over."),
          };
  const agent = node({
    id: "agent",
    kind: "agent",
    title: "Triage agent",
    subtitle: "Plans, simulates, explains",
    status: agentStatus,
    startedAt: s.steps.length ? T.connectedAt + 1000 : null,
    endedAt: !agentRunning && s.steps.length && !waiting ? t : null,
    items: simsDone || null,
    panel: { ...agentPanel, fold: plan(s.steps, waiting) },
  });

  // Models as configured in agent/lucid/config.py (LUCID_MODEL, LUCID_REGION_MODEL).
  const model = node({
    id: "model",
    kind: "model",
    title: "Chat model",
    subtitle: "Claude",
    status: agent.status === "idle" ? "idle" : "success",
    panel:
      agent.status === "idle"
        ? { hero: null, sentence: "Used once the triage agent starts.", quiet: true }
        : { hero: { kind: "statement", text: "Claude", icon: "anthropic" }, sentence: "Sonnet 5 runs the triage agent, and Haiku 5.5 runs the region agents." },
  });

  // The agent's memory is the patient baseline in the LangGraph store (agent/README.md):
  // recall_baseline reads it at the start; an approved result becomes the baseline,
  // so a re-scan is judged against the same head. The demo is the patient's first scan.
  const approved = approval?.state === "approved";
  const baseline = LIVE ? s.baseline : null;
  const saved = LIVE ? baseline === null && stated && scan.status !== "uncertain" : approved && top !== null;
  const memory = node({
    id: "memory",
    kind: "memory",
    title: "Patient memory",
    subtitle: "Baseline store",
    status: agent.status === "idle" ? "idle" : "success",
    panel:
      agent.status === "idle"
        ? { hero: null, sentence: "Read once the triage agent starts.", quiet: true }
        : baseline === undefined
          ? { hero: null, sentence: agentStatus === "running" ? "Looking up this patient's baseline." : "No baseline was read in this run." }
          : baseline
            ? { hero: { kind: "statement", text: "Re-scan" }, sentence: "This patient has a baseline, so the scan is judged against it." }
            : saved
              ? { hero: { kind: "statement", text: "Baseline saved" }, sentence: "The approved result is now this patient's baseline." }
              : { hero: { kind: "statement", text: "First scan" }, sentence: "There is no baseline for this patient yet." },
  });

  // ---- Tools and region agents ----

  const simsSpan = span(t, T.simAt, simsDone === s.sims.length ? T.simEnd : null);
  const simTool = node({
    id: "forward_sim",
    kind: "tool",
    title: "forward_sim",
    subtitle: "Simulate a bleed",
    ...simsSpan,
    items: simsDone || null,
    panel:
      simsSpan.status === "idle"
        ? { hero: null, sentence: "Runs once the scan is complete.", quiet: true }
        : {
            hero: !simsDone ? null : { kind: "number", label: "Simulated", value: simsSpan.status === "success" ? `${s.sims.length}` : `${simsDone} of ${s.sims.length}` },
            sentence: `${simsSpan.status === "success" ? "Predicted" : "Predicting"} what the 8 spots would read for each bleed hypothesis.`,
          },
  });
  const fitTool = node({
    id: "fit_score",
    kind: "tool",
    title: "fit_score",
    subtitle: "Compare to the map",
    ...simsSpan,
    items: simsDone || null,
    panel:
      simsSpan.status === "idle"
        ? { hero: null, sentence: "Runs once the scan is complete.", quiet: true }
        : !top
          ? { hero: null, sentence: "Waiting for the first simulation to finish." }
          : simsSpan.status === "success"
            ? { hero: { kind: "fit", map: top.map, label: "Best fit", value: top.score.toFixed(2) }, sentence: `Scored how closely each of the ${s.sims.length} simulations matches the scan.` }
            : { hero: { kind: "fit", map: top.map, label: "Best so far", value: top.score.toFixed(2) }, sentence: `Scored ${simsDone} of ${s.sims.length} simulations against the scan.` },
  });

  const regions = REGION_IDS.map((r) => {
    const a = s.agents.find((x) => x.region === r)!;
    const mine = s.sims.filter((x) => x.agent === r);
    const lead = best(mine);
    const finished = a.state === "done";
    return node({
      id: `region-${r}`,
      kind: "subagent",
      title: `${r[0].toUpperCase()}${r.slice(1)} agent`,
      subtitle: `${a.total} hypotheses`,
      status: finished ? "success" : a.state === "running" ? "running" : "idle",
      startedAt: a.state === "idle" ? null : T.simAt,
      endedAt: finished ? T.simEnd : null,
      items: a.done || null,
      panel:
        a.state === "idle"
          ? { hero: null, sentence: "Starts once the scan is complete.", quiet: true }
          : {
              hero: lead ? { kind: "fit", map: lead.map, label: finished ? "Best fit" : "Best so far", value: lead.score.toFixed(2) } : null,
              sentence:
                finished && lead
                  ? `${TYPE[lead.type]} at ${place(lead.region)}, ${ml(lead.volume_ml)}, fits best of the ${mine.length} it tested.`
                  : a.done
                    ? `Tested ${a.done} of ${mine.length} hypotheses.`
                    : `Testing ${mine.length} bleed hypotheses.`,
              fold: mine.length
                ? {
                    kind: "hypotheses",
                    title: "Hypotheses",
                    count: `${mine.length}`,
                    // Scored first, best at the top; the rest in the order they will run.
                    items: [...mine]
                      .sort((x, y) => (y.status === "done" ? y.score : -1) - (x.status === "done" ? x.score : -1))
                      .map((x) => ({ id: x.id, label: hypothesis(x), score: x.status === "done" ? x.score : null, best: x === lead && finished })),
                  }
                : undefined,
            },
    });
  });

  const rankSpan = span(t, T.simEnd, T.simEnd + 300);
  const rank = node({
    id: "rank",
    kind: "step",
    title: "Rank best fit",
    subtitle: "Top hypothesis",
    ...rankSpan,
    items: ranked ? 1 : null,
    panel:
      ranked && top
        ? {
            hero: { kind: "fit", map: top.map, label: "Best fit", value: top.score.toFixed(2) },
            sentence: `${TYPE[top.type]} bleed at ${place(top.region)}, about ${ml(top.volume_ml)}, ranks first of ${s.sims.length}.`,
          }
        : rankSpan.status === "running"
          ? { hero: null, sentence: "Ranking the scored hypotheses." }
          : { hero: null, sentence: "Runs once every simulation is scored.", quiet: true },
  });

  // ---- The medic and the hand-off ----

  // What the medic was asked, as the object of "approved" or "rejected".
  const asked = !approval
    ? ""
    : /^send pre-alert/i.test(approval.action)
      ? "the pre-alert"
      : /^mark this scan (.+?)\??$/i.exec(approval.action)?.[1] ?? `“${approval.action.replace(/\?$/, "")}”`;
  // The card's detail can run to several sentences; the panel keeps the first.
  const firstSentence = (x: string) => x.split(/(?<=[.!?])\s+(?=[A-Z])/)[0];
  const approvalNode = node({
    id: "approval",
    kind: "wait",
    title: "Medic approval",
    subtitle: "Waits for a human",
    status: !approval ? "idle" : approval.state === "pending" ? "waiting" : approval.state === "approved" ? "success" : "error",
    startedAt: approval ? T.approvalAt : null,
    items: approval && approval.state !== "pending" ? 1 : null,
    panel: !approval
      ? { hero: null, sentence: "Asks the medic once there is a result.", quiet: true }
      : approval.state === "pending"
        ? { hero: { kind: "statement", text: approval.title ?? approval.action, size: "question" }, sentence: firstSentence(approval.detail ?? ""), actions: true }
        : approval.state === "approved"
          ? rescanAsk
            ? { status: "Re-scanned", hero: { kind: "statement", text: "Re-scanned", tone: "primary", icon: "check" }, sentence: "The medic scanned the spots again." }
            : { status: "Approved", hero: { kind: "statement", text: "Approved", tone: "primary", icon: "check" }, sentence: `The medic approved ${asked}.` }
          : rescanAsk
            ? { status: "Skipped", hero: { kind: "statement", text: "Skipped", tone: "bleed", icon: "x" }, sentence: "The medic skipped the re-scan." }
            : { hero: { kind: "statement", text: "Rejected", tone: "bleed", icon: "x" }, sentence: `The medic rejected ${asked}.` },
  });

  const sentTo = s.steps.find((x) => x.label === "Sending pre-alert")?.detail;
  const h = s.handoff;
  const alert = h
    ? handoffAlert(h)
    : node({
        id: "alert",
        kind: "action",
        title: "Send pre-alert",
        subtitle: "Receiving trauma center",
        status: alertSent ? "success" : "idle",
        items: alertSent ? 1 : null,
        panel: alertSent
          ? {
              hero: { kind: "statement", text: "Pre-alert sent", tone: "primary", icon: "check" },
              sentence: LIVE
                ? `It went to ${sentTo ? (sentTo.startsWith("the ") ? sentTo : `the ${sentTo}`) : "the receiving trauma center"}.`
                : "The map, the best fit and the scan log went to the trauma center.",
            }
          : { hero: null, sentence: "Not sent.", quiet: true },
      });

  // Live mode: what became of the pre-alert, as an n8n If: a reply, or silence and a call.
  const handoff = LIVE ? handoffNodes(s, h) : null;

  const nodes = [device, spots, map, agent, rank, approvalNode, alert, ...(handoff?.nodes ?? []), model, memory, simTool, fitTool, ...regions];

  const edges: TraceEdge[] = [
    ...MAIN.slice(1).map((id, i) => ({ from: MAIN[i], to: id, kind: "main" as const })),
    ...(handoff?.edges ?? []),
    { from: "model", to: "agent", kind: "ai" },
    { from: "memory", to: "agent", kind: "ai" },
    { from: "forward_sim", to: "agent", kind: "ai" },
    { from: "fit_score", to: "agent", kind: "ai" },
    ...regions.map((r) => ({ from: r.id, to: "agent", kind: "ai" as const })),
  ];

  // Log: one line per node start and finish, in time order.
  const logs: TraceLog[] = [];
  for (const n of nodes) {
    if (n.startedAt !== null && n.kind !== "model" && n.kind !== "memory") logs.push({ at: n.startedAt, nodeId: n.id, node: n.title, text: "started" });
    if (n.endedAt !== null && n.id !== "agent") logs.push({ at: n.endedAt, nodeId: n.id, node: n.title, text: n.items ? `finished · ${n.items} item${n.items === 1 ? "" : "s"}` : "finished" });
  }
  if (approval && approval.state !== "pending") logs.push({ at: T.approvalAt, nodeId: "approval", node: "Medic approval", text: approval.state });
  logs.sort((a, b) => a.at - b.at);

  return { nodes, edges, logs };
}
