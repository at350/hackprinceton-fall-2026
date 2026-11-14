import { demo } from "./demo";
import type { DashState, RegionName } from "./types";

// The agent run as a graph: the main pipeline left to right, and the triage
// agent's model, memory, tools and region sub-agents attached underneath it.

export type TraceStatus = "idle" | "running" | "waiting" | "success" | "error";
export type TraceKind = "trigger" | "step" | "agent" | "wait" | "action" | "model" | "memory" | "tool" | "subagent";

export interface TraceNode {
  id: string;
  kind: TraceKind;
  title: string;
  subtitle: string;
  status: TraceStatus;
  startedAt: number | null; // demo ms
  endedAt: number | null;
  items: number | null; // items produced so far
  input: [string, string][];
  output: [string, string][];
  reasoning: string[];
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

function span(t: number, start: number, end: number | null): Pick<TraceNode, "status" | "startedAt" | "endedAt"> {
  if (t < start) return { status: "idle", startedAt: null, endedAt: null };
  if (end === null || t < end) return { status: "running", startedAt: start, endedAt: null };
  return { status: "success", startedAt: start, endedAt: end };
}

export function deriveTrace(s: DashState): Trace {
  const t = s.t;
  const T = demo.timeline;
  const spotsDone = s.spots.filter((p) => p.state === "done").length;
  const simsDone = s.sims.filter((x) => x.status === "done").length;
  const best = s.sims.filter((x) => x.status === "done").sort((a, b) => b.score - a.score)[0];
  const scan = s.scan;
  const approval = s.approval;
  // Every spot visited (a weak-contact spot counts as read).
  const scanned = s.spots.every((p) => p.state === "done" || p.state === "rescan");
  // Live mode: no result is stated until the medic approves it.
  const stated = scan !== null && scan.status !== "pending" && scan.status !== "rejected";
  const alertSent = T.alertSent ?? approval?.state === "approved";
  const agentMsgs = s.messages.filter((m) => m.role === "agent" && m.shown >= m.text.length).map((m) => m.text);

  const node = (n: Partial<TraceNode> & Pick<TraceNode, "id" | "kind" | "title" | "subtitle">): TraceNode => ({
    status: "idle",
    startedAt: null,
    endedAt: null,
    items: null,
    input: [],
    output: [],
    reasoning: [],
    ...n,
  });

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
    items: s.device === "disconnected" || s.device === "connecting" ? null : 1,
    output: [
      ["status", s.device],
      ["signal", s.quality],
    ],
  });

  const spots = node({
    id: "spots",
    kind: "step",
    title: "Read scan spots",
    subtitle: "8 spots around the head",
    ...span(t, T.scanAt, scanned ? T.scanEnd : null),
    items: spotsDone || null,
    output: s.spots.filter((p) => p.peak !== null).map((p) => [p.name, `peak ${p.peak!.toFixed(2)}`]),
  });

  const map = node({
    id: "map",
    kind: "step",
    title: "Build likelihood map",
    subtitle: "64 × 64 grid",
    ...span(t, T.firstMapAt, scanned ? T.scanEnd : null),
    items: scan ? 1 : null,
    input: [["spots", `${spotsDone} of 8`]],
    output: !scan
      ? []
      : !stated
        ? [["status", scan.status]]
        : [
          ["status", scan.status],
          ["region", scan.region],
          ["volume", scan.volume_ml ? `${scan.volume_ml} mL` : "none"],
          ["confidence", `${Math.round(scan.confidence * 100)}%`],
        ],
  });

  const agentRunning = s.steps.some((x) => x.state === "running");
  const agent = node({
    id: "agent",
    kind: "agent",
    title: "Triage agent",
    subtitle: "Plans, simulates, explains",
    status: approval?.state === "pending" ? "waiting" : agentRunning ? "running" : s.steps.length ? "success" : "idle",
    startedAt: s.steps.length ? T.connectedAt + 1000 : null,
    endedAt: !agentRunning && s.steps.length && approval?.state !== "pending" ? t : null,
    items: simsDone || null,
    input: scan ? [["map", stated ? `${scan.status}, ${scan.region}` : scan.status]] : [],
    // What the agent produced, not its step statuses (those are in the log).
    output: [
      ...(scan && stated ? ([["verdict", scan.status === "bleed" ? "Bleed likely" : scan.status === "uncertain" ? "Uncertain, re-scan" : "No bleed seen"]] as [string, string][]) : []),
      ...(t >= T.simEnd + 300 && best ? ([["best fit", `${best.type}, ${best.region}, ${best.volume_ml} mL (${best.score.toFixed(2)})`]] as [string, string][]) : []),
      ...(approval ? ([["recommendation", approval.action]] as [string, string][]) : []),
    ],
    reasoning: agentMsgs,
  });

  // Models as configured in agent/lucid/config.py (LUCID_MODEL, LUCID_REGION_MODEL).
  const model = node({
    id: "model",
    kind: "model",
    title: "Chat model",
    subtitle: "Claude",
    status: agent.status === "idle" ? "idle" : "success",
    output: [
      ["triage lead", "Claude Sonnet 5"],
      ["region agents", "Claude Haiku 5.5"],
    ],
  });

  // The agent's memory is the patient baseline in the LangGraph store (agent/README.md):
  // recall_baseline reads it at the start; an approved result becomes the baseline,
  // so a re-scan is judged against the same head.
  const approved = approval?.state === "approved";
  const memory = node({
    id: "memory",
    kind: "memory",
    title: "Patient memory",
    subtitle: "Baseline store",
    status: agent.status === "idle" ? "idle" : "success",
    input: agent.status === "idle" ? [] : [["recall_baseline", "this patient's first approved scan"]],
    output:
      agent.status === "idle"
        ? []
        : [
            ["baseline found", "None. This is the patient's first scan"],
            ...(approved && best
              ? ([["saved as baseline", `${best.type}, ${best.region}, ${best.volume_ml} mL`], ["used for", "the re-scan in 10 minutes"]] as [string, string][])
              : ([["saves", "the approved result, for the next re-scan"]] as [string, string][])),
          ],
  });

  const simTool = node({
    id: "forward_sim",
    kind: "tool",
    title: "forward_sim",
    subtitle: "Simulate a bleed",
    ...span(t, T.simAt, simsDone === s.sims.length ? T.simEnd : null),
    items: simsDone || null,
  });
  const fitTool = node({
    id: "fit_score",
    kind: "tool",
    title: "fit_score",
    subtitle: "Compare to the map",
    ...span(t, T.simAt, simsDone === s.sims.length ? T.simEnd : null),
    items: simsDone || null,
    output: best ? [["best", `${best.type}, ${best.region}, ${best.volume_ml} mL (${best.score.toFixed(2)})`]] : [],
  });

  const regions = REGION_IDS.map((r) => {
    const a = s.agents.find((x) => x.region === r)!;
    const mine = s.sims.filter((x) => x.agent === r && x.status === "done").sort((x, y) => y.score - x.score);
    return node({
      id: `region-${r}`,
      kind: "subagent",
      title: `${r[0].toUpperCase()}${r.slice(1)} agent`,
      subtitle: `${a.total} hypotheses`,
      status: a.state === "done" ? "success" : a.state === "running" ? "running" : "idle",
      startedAt: a.state === "idle" ? null : T.simAt,
      endedAt: a.state === "done" ? T.simEnd : null,
      items: a.done || null,
      output: mine.slice(0, 3).map((x) => [`${x.type}, ${x.region}`, x.score.toFixed(2)]),
    });
  });

  const rank = node({
    id: "rank",
    kind: "step",
    title: "Rank best fit",
    subtitle: "Top hypothesis",
    ...span(t, T.simEnd, T.simEnd + 300),
    items: t >= T.simEnd + 300 ? 1 : null,
    output: t >= T.simEnd + 300 && best ? [["best fit", `${best.type}, ${best.region}, ${best.volume_ml} mL`], ["fit", best.score.toFixed(2)]] : [],
  });

  const approvalNode = node({
    id: "approval",
    kind: "wait",
    title: "Medic approval",
    subtitle: "Waits for a human",
    status: !approval ? "idle" : approval.state === "pending" ? "waiting" : approval.state === "approved" ? "success" : "error",
    startedAt: approval ? T.approvalAt : null,
    items: approval && approval.state !== "pending" ? 1 : null,
    output: approval ? [["action", approval.action], ["decision", approval.state]] : [],
  });

  const alert = node({
    id: "alert",
    kind: "action",
    title: "Send pre-alert",
    subtitle: "Receiving trauma center",
    status: alertSent ? "success" : "idle",
    items: alertSent ? 1 : null,
    output: alertSent ? [["sent", "map, best fit, scan log"]] : [],
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
