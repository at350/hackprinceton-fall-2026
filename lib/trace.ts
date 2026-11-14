import { demo } from "./demo";
import { LIVE } from "./live";
import type { AgentStep, DashState, RegionName, ScanSpot, ScanStatus, Simulation, StepState } from "./types";

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
  | { kind: "statement"; text: string; tone?: "primary" | "bleed"; icon?: "check" | "x"; size?: "question" }
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
  | { kind: "hypotheses"; title: string; count: string; items: { id: string; label: string; score: number | null; best: boolean }[] };

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

function span(t: number, start: number, end: number | null): Pick<TraceNode, "status" | "startedAt" | "endedAt"> {
  if (t < start) return { status: "idle", startedAt: null, endedAt: null };
  if (end === null || t < end) return { status: "running", startedAt: start, endedAt: null };
  return { status: "success", startedAt: start, endedAt: end };
}

const best = (sims: Simulation[]) =>
  sims.filter((x) => x.status === "done").reduce<Simulation | null>((a, b) => (!a || b.score > a.score ? b : a), null);

const hypothesis = (x: Simulation) => `${TYPE[x.type]}, ${x.region}, ${x.volume_ml} mL`;

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

  const node = (n: Omit<TraceNode, "status" | "startedAt" | "endedAt" | "items"> & Partial<TraceNode>): TraceNode => ({
    status: "idle",
    startedAt: null,
    endedAt: null,
    items: null,
    ...n,
  });

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
                ? `All 8 spots read${highest ? `; ${highest.name} reads highest` : ""}.`
                : current
                  ? `${spotsDone} of 8 spots read; now on ${current.name}.`
                  : `${spotsDone} of 8 spots read.`,
          },
  });

  const mapSpan = span(t, T.firstMapAt, scanned ? T.scanEnd : null);
  const where = stated && scan.region && scan.region !== "None" ? `, peaking at ${scan.region}${scan.volume_ml ? `, about ${scan.volume_ml} mL` : ""}` : "";
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
      ? `${top && top.region === scan.region ? `${TYPE[top.type]} bleed` : "Bleed"} at ${scan.region}${scan.volume_ml ? `, about ${scan.volume_ml} mL` : ""}.`
      : null;
  const tested = simsDone ? `Tested ${simsDone} bleed hypotheses with ${new Set(done.map((x) => x.agent)).size} region agents.` : null;
  const runningTodo = todos.find((x) => x.state === "running");
  const runningTool = [...s.steps].reverse().find((x) => x.kind === "tool" && x.state === "running");
  // After a live rejection the scan stays pending: nothing was recorded.
  const verdict: ScanStatus | null = !scan ? null : scan.status === "pending" ? (approval?.state === "rejected" ? "rejected" : null) : scan.status;
  const agentPanel: TracePanel =
    agentStatus === "idle"
      ? { hero: null, sentence: LIVE ? (s.device === "scanning" ? "Starting." : "Starts when you run a scan.") : "Starts when the device connects.", quiet: true }
      : agentStatus === "running"
        ? {
            hero: runningTodo ? { kind: "statement", text: runningTodo.label, size: "question" } : null,
            sentence: runningTool ? `${runningTool.label}${runningTool.detail ? `, ${runningTool.detail}` : ""}.` : `On step ${todos.indexOf(runningTodo!) + 1} of ${todos.length}.`,
          }
        : {
            hero: stated ? { kind: "verdict", status: scan.status } : waiting ? { kind: "statement", text: approval.title ?? approval.action, size: "question" } : verdict ? { kind: "verdict", status: verdict } : null,
            sentence: finding ?? (waiting && top && !stated ? `Best fit so far: ${hypothesis(top)}.` : tested ?? "The run is over."),
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
        : { hero: { kind: "statement", text: "Claude" }, sentence: "Sonnet 5 runs the triage agent, and Haiku 5.5 runs the region agents." },
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
            hero: { kind: "number", label: "Simulated", value: simsSpan.status === "success" ? `${s.sims.length}` : `${simsDone} of ${s.sims.length}` },
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
                  ? `${TYPE[lead.type]} at ${lead.region}, ${lead.volume_ml} mL, fits best of the ${mine.length} it tested.`
                  : `Tested ${a.done} of ${mine.length} hypotheses.`,
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
            sentence: `${TYPE[top.type]} bleed at ${top.region}, about ${top.volume_ml} mL, ranks first of ${s.sims.length}.`,
          }
        : rankSpan.status === "running"
          ? { hero: null, sentence: "Ranking the scored hypotheses." }
          : { hero: null, sentence: "Runs once every simulation is scored.", quiet: true },
  });

  // ---- The medic and the hand-off ----

  const lower = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);
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
        ? { hero: { kind: "statement", text: approval.title ?? approval.action, size: "question" }, sentence: approval.detail ?? "", actions: true }
        : approval.state === "approved"
          ? rescanAsk
            ? { status: "Re-scanned", hero: { kind: "statement", text: "Re-scanned", tone: "primary", icon: "check" }, sentence: "The medic scanned the spots again." }
            : { status: "Approved", hero: { kind: "statement", text: "Approved", tone: "primary", icon: "check" }, sentence: `The medic approved: ${lower(approval.action)}.` }
          : rescanAsk
            ? { status: "Skipped", hero: { kind: "statement", text: "Skipped", tone: "bleed", icon: "x" }, sentence: "The medic skipped the re-scan." }
            : { hero: { kind: "statement", text: "Rejected", tone: "bleed", icon: "x" }, sentence: `The medic rejected: ${lower(approval.action)}.` },
  });

  const sentTo = s.steps.find((x) => x.label === "Sending pre-alert")?.detail;
  const alert = node({
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

  const nodes = [device, spots, map, agent, rank, approvalNode, alert, model, memory, simTool, fitTool, ...regions];

  const edges: TraceEdge[] = [
    ...MAIN.slice(1).map((id, i) => ({ from: MAIN[i], to: id, kind: "main" as const })),
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
