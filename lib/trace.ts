import { TIMELINE } from "./demo";
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
  const T = TIMELINE;
  const spotsDone = s.spots.filter((p) => p.state === "done").length;
  const simsDone = s.sims.filter((x) => x.status === "done").length;
  const best = s.sims.filter((x) => x.status === "done").sort((a, b) => b.score - a.score)[0];
  const scan = s.scan;
  const approval = s.approval;
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
    ...span(t, T.scanAt, spotsDone === 8 ? T.scanEnd : null),
    items: spotsDone || null,
    output: s.spots.filter((p) => p.peak !== null).map((p) => [p.name, `peak ${p.peak!.toFixed(2)}`]),
  });

  const map = node({
    id: "map",
    kind: "step",
    title: "Build likelihood map",
    subtitle: "64 × 64 grid",
    ...span(t, T.firstMapAt, spotsDone === 8 ? T.scanEnd : null),
    items: scan ? 1 : null,
    input: [["spots", `${spotsDone} of 8`]],
    output: scan
      ? [
          ["status", scan.status],
          ["region", scan.region],
          ["volume", scan.volume_ml ? `${scan.volume_ml} mL` : "none"],
          ["confidence", `${Math.round(scan.confidence * 100)}%`],
        ]
      : [],
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
    items: agentMsgs.length || null,
    input: scan ? [["map", `${scan.status}, ${scan.region}`]] : [],
    output: s.steps.filter((x) => x.kind === "todo").map((x) => [x.label, x.state]),
    reasoning: agentMsgs,
  });

  const model = node({ id: "model", kind: "model", title: "Chat model", subtitle: "Claude", status: agent.status === "idle" ? "idle" : "success" });
  const memory = node({ id: "memory", kind: "memory", title: "Scan memory", subtitle: "Thread state", status: agent.status === "idle" ? "idle" : "success" });

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
    status: approval?.state === "approved" ? "success" : "idle",
    items: approval?.state === "approved" ? 1 : null,
    output: approval?.state === "approved" ? [["sent", "map, best fit, scan log"]] : [],
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
    if (n.startedAt !== null && n.kind !== "model" && n.kind !== "memory") logs.push({ at: n.startedAt, node: n.title, text: "started" });
    if (n.endedAt !== null && n.id !== "agent") logs.push({ at: n.endedAt, node: n.title, text: n.items ? `finished · ${n.items} item${n.items === 1 ? "" : "s"}` : "finished" });
  }
  if (approval && approval.state !== "pending") logs.push({ at: T.approvalAt, node: "Medic approval", text: approval.state });
  logs.sort((a, b) => a.at - b.at);

  return { nodes, edges, logs };
}
