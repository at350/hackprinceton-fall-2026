import { SAMPLE_RATE_HZ } from "./config";
import { devicePresence } from "./device";
import { type Tagged, mergeHandoff, parseTagged, sameHandoff } from "./handoff";
import { REGIONS, deviceBuffer, deviceSample, initialSpots } from "./mock";
import { type Mode, getMode, modeDef, subscribeMode } from "./mode";
import type {
  AgentActivity,
  AgentStep,
  ApprovalRequest,
  ChatMessage,
  DashState,
  RegionAgent,
  ScanReading,
  ScanSpot,
  ScanUpdate,
  Simulation,
  StepState,
  TabId,
  ViewId,
} from "./types";

// The dashboard state, driven by the real LangGraph agent. <LiveBridge/> owns the
// stream and feeds this store. Where scans come from is the mode (lib/mode.ts).

export const AGENT_URL = process.env.NEXT_PUBLIC_LANGGRAPH_URL ?? "http://localhost:2024";
export const ASSISTANT_ID = "lucid";

// Mock scans the backend can replay (the Simulated device mode).
export type ScanCase = "temporal_bleed" | "clear" | "uncertain";
export const SCAN_CASES: { id: ScanCase; label: string }[] = [
  { id: "temporal_bleed", label: "Temporal bleed" },
  { id: "clear", label: "Clear" },
  { id: "uncertain", label: "Uncertain" },
];

const TRIGGER = "New scan ready.";
const REJECT_MESSAGE = "The medic rejected this.";
const SKIP_MESSAGE = "The medic skipped the re-scan.";

// ---- Wire shapes (what the agent sends) -----------------------------------

interface WireToolCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface WireMessage {
  id?: string;
  type: string; // "human" | "ai" | "tool" | ...
  content: unknown; // string, or an array of content blocks
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
  name?: string;
  status?: string; // tool messages: "error" when the call failed or the medic rejected it
}

interface Preview {
  hypothesis_id: string;
  map: number[][];
}

// Thread state `handoff`: {to, message, report, sent_at, simulated, channel, status, reply}.
// Read loosely; lib/handoff.ts merges it with the Store record.
type HandoffState = Record<string, unknown>;

type SimPatch = Partial<Simulation> & { id: string };

export interface LiveValues {
  [key: string]: unknown;
  messages?: WireMessage[];
  todos?: { content: string; status: "pending" | "in_progress" | "completed" }[];
  scan?: ScanUpdate | null;
  spots?: ScanSpot[];
  sims?: SimPatch[];
  reading?: ScanReading | null;
  baseline?: { taken_at?: string } | null;
  preview?: Preview | null;
  handoff?: HandoffState | null;
}

export type LiveEvent =
  | { type: "scan"; scan: ScanUpdate; spots?: ScanSpot[]; reading?: ScanReading }
  | { type: "activity"; item: AgentActivity }
  | { type: "todos"; todos: NonNullable<LiveValues["todos"]> }
  | { type: "sims_reset"; sims: SimPatch[] }
  | { type: "sims"; sims: SimPatch[] }
  | { type: "preview"; preview: Preview | null }
  | { type: "handoff"; handoff: HandoffState | null };

export interface LiveSnapshot {
  values: LiveValues;
  messages: WireMessage[];
  interrupt: unknown;
  isLoading: boolean;
  error: unknown;
}

/** What the store may ask the stream to do. */
export interface LiveBridgeHandle {
  submit: (input: LiveValues | null, resume?: unknown) => void;
  stop: () => void;
}

/** Milestones for the agent trace, in ms since "Run scan" (Infinity = not reached). */
export interface Timeline {
  connectedAt: number;
  scanAt: number;
  firstMapAt: number;
  scanEnd: number;
  simAt: number;
  simEnd: number;
  approvalAt: number;
  alertSent: boolean;
}

// ---- Mapping helpers ------------------------------------------------------

const SIM_RANK = { queued: 0, running: 1, done: 2 } as const;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (typeof b === "string" ? b : b && typeof b === "object" && b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .join("");
}

function sameGrid(a: number[][], b: number[][]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let r = 0; r < a.length; r++) {
    const x = a[r], y = b[r];
    if (x.length !== y.length) return false;
    for (let c = 0; c < x.length; c++) if (x[c] !== y[c]) return false;
  }
  return true;
}

function sameList<T extends object>(a: T[], b: T[]) {
  if (a.length !== b.length) return false;
  return a.every((x, i) => (Object.keys(x) as (keyof T)[]).every((k) => x[k] === b[i][k]));
}

function deriveAgents(sims: Simulation[]): RegionAgent[] {
  return REGIONS.map((region) => {
    const mine = sims.filter((s) => s.agent === region);
    const done = mine.filter((s) => s.status === "done").length;
    const started = done > 0 || mine.some((s) => s.status === "running");
    return { region, done, total: mine.length, state: mine.length && done === mine.length ? "done" : started ? "running" : "idle" };
  });
}

/** The plan row a lead tool call shows as: which row, under which to-do. */
function toolRow(call: WireToolCall): { key: string; label: string; todo: number; detail?: string } | null {
  switch (call.name) {
    case "read_scan":
      return { key: "read", label: "Reading scan", todo: 0 };
    case "recall_baseline":
      return { key: "baseline", label: "Checking baseline", todo: 0 };
    case "plan_hypotheses":
      return { key: "plan", label: "Planning hypotheses", todo: 1 };
    case "task":
      // The four region agents share one row; the skeptic gets its own.
      return call.args?.subagent_type === "skeptic"
        ? { key: "skeptic", label: "Second check", todo: 3 }
        : { key: "sim", label: "Running simulations", todo: 2 };
    case "fit_score":
    case "rank_fits":
      return { key: "fit", label: "Scoring fit", todo: 3 };
    case "render_map":
      return { key: "map", label: "Rendering map", todo: 3 };
    case "request_rescan":
      return { key: "rescan", label: "Asking for re-scan", todo: 4 };
    case "write_file":
      return call.args?.file_path === "/report.md" ? { key: "report", label: "Writing hand-off report", todo: 4 } : null;
    case "submit_result":
      return { key: "result", label: "Recording result", todo: 4 };
    case "send_prealert": {
      const to = call.args?.destination;
      return { key: "alert", label: "Sending pre-alert", todo: 4, detail: typeof to === "string" ? to : undefined };
    }
    case "read_file": {
      const path = call.args?.file_path ?? call.args?.path;
      const skill = typeof path === "string" ? /\/skills\/([^/]+)\/SKILL\.md$/.exec(path)?.[1] : undefined;
      return skill ? { key: `skill-${skill}`, label: "Reading skill", todo: 2, detail: skill } : null;
    }
    default:
      return null; // write_todos and file housekeeping are not shown
  }
}

function errorText(err: unknown) {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (err instanceof TypeError || /fetch|network|load failed|ECONNREFUSED/i.test(msg)) {
    let host = AGENT_URL;
    try {
      host = new URL(AGENT_URL).host;
    } catch {}
    return `Can't reach the agent at ${host}. Start it with \`langgraph dev\` in /agent.`;
  }
  return msg ? `The agent run stopped with an error: ${msg}` : "The agent run stopped with an error.";
}

function initialState(mode: Mode, run = 0, view: ViewId = "dashboard"): DashState {
  return {
    run,
    view,
    t: 0,
    device: devicePresence(mode).connected ? "connected" : "disconnected",
    quality: "good",
    scanStartedAt: null,
    scanEndedAt: null,
    spots: initialSpots(),
    currentSpot: null,
    scan: null,
    reading: null,
    sims: [],
    activity: {},
    agents: deriveAgents([]),
    steps: [],
    messages: [],
    approval: null,
    tab: "scan",
    tabPinnedByUser: false,
  };
}

const idleTimeline = (): Timeline => ({
  connectedAt: 0,
  scanAt: Infinity,
  firstMapAt: Infinity,
  scanEnd: Infinity,
  simAt: Infinity,
  simEnd: Infinity,
  approvalAt: Infinity,
  alertSent: false,
});

// ---- Store ----------------------------------------------------------------

let uid = 0;

export class LiveStore {
  // The mode this state belongs to; a switch starts over (see syncMode).
  private mode: Mode = getMode();
  state: DashState = initialState(this.mode);
  timeline: Timeline = idleTimeline();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeMode: (() => void) | null = null;
  private sampleClock = 0;
  private runStart = 0;
  private busy = false; // a run is streaming or waiting for the medic
  private streaming = false; // the stream reported loading since the last submit
  private failed = false;
  private pendingStart: ScanCase | null = null;
  private lastCase: ScanCase = "temporal_bleed";
  // One patient per page load: a second run is a re-scan against the saved baseline.
  // Reads as "Patient P-7K3Q" in the texts and on the call.
  private patientId = `P-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  private bridge: LiveBridgeHandle | null = null;

  // Latest wire data, and the refs already applied from `values`.
  private wire: { messages: WireMessage[]; isLoading: boolean } = { messages: [], isLoading: false };
  private seen: Partial<Record<"scan" | "spots" | "sims" | "reading" | "baseline" | "preview" | "handoff", unknown>> = {};
  private todos: NonNullable<LiveValues["todos"]> = [];
  private rawScan: ScanUpdate | null = null;
  private preview: Preview | null = null;
  // Messages that never reach the thread (errors, a rejection typed by the medic).
  private local: { after: number; queued: boolean; msg: ChatMessage }[] = [];
  private interrupt: { key: string; count: number; skip: boolean } | null = null;
  private resolved = new Set<string>();
  private patchTimer: ReturnType<typeof setTimeout> | null = null;
  // The hand-off: thread state `handoff`, and the Store record the bridge keeps current.
  private handoffState: unknown = null;
  private handoffRecord: unknown = null;
  // A run this page did not start (the Photon bridge's) is streaming into the hook.
  private external = false;
  // `wire` came from a thread-state read rather than the hook (see syncState).
  private polled = false;
  private tags = new Map<string, Tagged | null>();
  // This run's thread, so a bridge that a hot reload remounted opens it again.
  // Read with `?? null`: a store kept across a hot reload has no value for a field added since.
  private threadId: string | null = null;

  subscribe =(fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getState = () => this.state;

  private set(patch: Partial<DashState>) {
    this.state = { ...this.state, ...patch };
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  start() {
    if (this.timer) return;
    this.sampleClock = performance.now();
    this.timer = setInterval(() => this.tick(), 50);
    this.unsubscribeMode = subscribeMode(() => this.syncMode());
    this.syncMode();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribeMode?.();
    this.unsubscribeMode = null;
  }

  /** "Run scan": a fresh thread for the chosen mock scan. Needs a device. */
  restart(scan: ScanCase = this.lastCase) {
    if (!devicePresence(this.mode).connected) return;
    this.clear(scan);
    this.state = { ...this.state, device: "scanning", scanStartedAt: 0 };
    this.timeline = { ...idleTimeline(), scanAt: 0 };
    this.runStart = performance.now();
    this.busy = true;
    this.emit();
  }

  /** After a mode switch: no run, nothing left from the other mode. The patient stays (one per page load). */
  private syncMode() {
    const mode = getMode();
    if (mode === this.mode) return;
    this.mode = mode;
    this.clear(null);
    deviceBuffer.clear();
    this.emit();
  }

  /** Drops the run and its thread; a new run number mounts a new stream (see Dashboard). */
  private clear(start: ScanCase | null) {
    this.bridge?.stop();
    this.bridge = null;
    if (start) this.lastCase = start;
    this.pendingStart = start;
    this.state = initialState(this.mode, this.state.run + 1, this.state.view);
    this.timeline = idleTimeline();
    this.wire = { messages: [], isLoading: false };
    this.seen = {};
    this.todos = [];
    this.rawScan = null;
    this.preview = null;
    this.local = [];
    this.interrupt = null;
    this.resolved.clear();
    this.handoffState = null;
    this.handoffRecord = null;
    this.external = false;
    this.polled = false;
    this.threadId = null;
    this.busy = false;
    this.streaming = false;
    this.failed = false;
  }

  setView(view: ViewId) {
    this.set({ view });
    this.emit();
  }

  setTab(tab: TabId) {
    this.set({ tab, tabPinnedByUser: true });
    this.emit();
  }

  private autoTab(tab: TabId) {
    if (!this.state.tabPinnedByUser) this.set({ tab });
  }

  // -- stream bridge --

  attach(run: number, handle: LiveBridgeHandle) {
    if (run === this.state.run) this.bridge = handle;
  }

  detach(handle: LiveBridgeHandle) {
    if (this.bridge === handle) this.bridge = null;
  }

  setThread(run: number, id: string) {
    if (run === this.state.run) this.threadId = id;
  }

  thread(run: number) {
    return run === this.state.run ? (this.threadId ?? null) : null;
  }

  /** Called once the bridge for this run is mounted: send the scan trigger. */
  begin(run: number) {
    const scan = this.pendingStart;
    if (run !== this.state.run || !scan || !this.bridge) return;
    this.pendingStart = null;
    this.bridge.submit({ messages: [{ type: "human", content: TRIGGER }], scan_id: scan, patient_id: this.patientId });
  }

  /** The plan only moves forward within a run, so a `values` snapshot from before a `todos` event cannot undo it. */
  private applyTodos(todos: NonNullable<LiveValues["todos"]>) {
    const reached = (list: typeof todos) =>
      list.reduce((n, t) => n + (t.status === "completed" ? 2 : t.status === "in_progress" ? 1 : 0), 0);
    if (todos.length !== this.todos.length || reached(todos) >= reached(this.todos)) this.todos = todos;
  }

  /** A custom stream event. These arrive ahead of `values`, so apply them right away. */
  event(run: number, e: LiveEvent) {
    if (run !== this.state.run || !e || typeof e !== "object") return;
    if (e.type === "scan") {
      this.applyScan(e.scan, e.spots);
      if (e.reading) this.set({ reading: e.reading });
    } else if (e.type === "activity") this.applyActivity(e.item);
    else if (e.type === "todos") this.applyTodos(e.todos);
    else if (e.type === "sims_reset") this.applySims(e.sims, "reset");
    else if (e.type === "sims") this.applySims(e.sims, "patch");
    else if (e.type === "preview") this.applyPreview(e.preview);
    else if (e.type === "handoff") this.applyHandoff(e.handoff);
    else return;
    this.rebuild();
    // Simulation patches arrive dozens per second; repaint at most ten times a second.
    if (e.type !== "sims" && e.type !== "activity") this.emit();
    else this.patchTimer ??= setTimeout(() => {
      this.patchTimer = null;
      this.emit();
    }, 100);
  }

  /** The stream's current state; called on every stream update. */
  sync(run: number, snap: LiveSnapshot) {
    if (run !== this.state.run) return;
    // A thread-state read beats an idle hook that never heard of the bridge's run.
    if (this.polled && !snap.isLoading && (snap.messages?.length ?? 0) < this.wire.messages.length) return;
    this.polled = false;
    const v = snap.values ?? {};
    // Each field is applied only when the server sent a new copy of it.
    if (v.scan !== undefined && v.scan !== this.seen.scan) {
      this.seen.scan = v.scan;
      this.seen.spots = v.spots;
      if (v.scan) this.applyScan(v.scan, v.spots);
    } else if (v.spots?.length && v.spots !== this.seen.spots) {
      this.seen.spots = v.spots;
      this.set({ spots: v.spots });
    }
    if (v.reading && v.reading !== this.seen.reading) {
      this.seen.reading = v.reading;
      this.set({ reading: v.reading });
    }
    // recall_baseline's answer: null when this patient has none on file.
    if (v.baseline !== undefined && v.baseline !== this.seen.baseline) {
      this.seen.baseline = v.baseline;
      this.set({ baseline: v.baseline });
    }
    if (v.sims?.length && v.sims !== this.seen.sims) {
      this.seen.sims = v.sims;
      this.applySims(v.sims, "all");
    }
    if (v.preview !== undefined && v.preview !== this.seen.preview) {
      this.seen.preview = v.preview;
      this.applyPreview(v.preview);
    }
    if (v.handoff !== undefined && v.handoff !== this.seen.handoff) {
      this.seen.handoff = v.handoff;
      this.applyHandoff(v.handoff);
    }
    if (v.todos) this.applyTodos(v.todos);
    this.wire = { messages: snap.messages ?? [], isLoading: snap.isLoading };
    if (snap.isLoading) this.streaming = true;
    // Loading while this page started nothing: the bridge's run, joined (see LiveBridge).
    if (snap.isLoading && !this.busy) this.external = true;

    this.applyInterrupt(snap.isLoading ? null : snap.interrupt);
    if (snap.error && this.streaming && !snap.isLoading) this.fail(run, snap.error);

    // The run is over once the stream stops with nothing left to approve.
    if (this.busy && this.streaming && !snap.isLoading && this.state.approval?.state !== "pending") {
      this.busy = false;
      this.streaming = false;
      this.set({ device: "connected", scanEndedAt: this.state.scanEndedAt ?? this.state.t });
      this.rebuild();
      this.flushQueue();
    } else if (this.external && !snap.isLoading) {
      this.external = false;
      this.streaming = false;
      this.rebuild();
      this.flushQueue();
    } else {
      this.rebuild();
    }
    this.emit();
  }

  /** Fallback for a run the bridge started that was missed or could not be joined: the thread's state, read directly. */
  // `lost`: the hook dropped the run it was streaming (a hot reload), so the thread wins even over a run in progress.
  syncState(run: number, state: { values?: LiveValues | null; tasks?: { interrupts?: unknown[] }[] }, lost = false) {
    if (run !== this.state.run || (!lost && (this.busy || this.external))) return;
    const values = state.values ?? {};
    const interrupts = (state.tasks ?? []).flatMap((t) => t.interrupts ?? []);
    this.sync(run, { values, messages: values.messages ?? [], interrupt: interrupts.length ? interrupts : undefined, isLoading: false, error: undefined });
    this.polled = true;
  }

  /** The hand-off's Store record, read by the bridge every 2 s once the pre-alert has gone out. */
  setHandoffRecord(run: number, record: unknown) {
    if (run !== this.state.run) return;
    this.handoffRecord = record ?? null;
    if (this.showHandoff()) this.emit();
  }

  /** Whether there is a hand-off to follow: the pre-alert has gone out on this run's thread. */
  handoffOpen(run: number) {
    return run === this.state.run && (this.handoffState !== null || this.handoffRecord !== null);
  }

  /** Whether this page's own run is idle, so a new run on the thread is someone else's. */
  idle(run: number) {
    return run === this.state.run && !this.busy && !this.external;
  }

  /** Whether the hook holds fewer of this run's messages than the chat shows: a hot reload rebuilt it. */
  behind(run: number, messages: number) {
    return run === this.state.run && messages < this.wire.messages.length;
  }

  fail(run: number, err: unknown) {
    if (run !== this.state.run || this.failed) return;
    this.failed = true;
    this.busy = false;
    this.streaming = false;
    this.pendingStart = null;
    this.say(errorText(err), "agent");
    this.set({ device: "connected", scanEndedAt: this.state.scanEndedAt ?? this.state.t });
    this.rebuild();
    this.emit();
  }

  // -- medic actions --

  sendMedic(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Typing while a card is up is a rejection with a reason.
    if (this.state.approval?.state === "pending") {
      this.say(trimmed, "medic");
      return this.resolveApproval(false, false, trimmed);
    }
    if (!this.wire.messages.length || !this.bridge) {
      const device = devicePresence(this.mode);
      this.say(trimmed, "medic");
      this.say(device.connected ? "No scan yet. Press Run scan to start." : `No scan yet: no device is connected. ${device.reason}.`, "agent");
    } else if (this.busy || this.external) {
      this.say(trimmed, "medic", true); // sent when the agent is free
    } else {
      this.follow(trimmed);
    }
    this.rebuild();
    this.emit();
  }

  resolveApproval(approved: boolean, auto = false, message = this.interrupt?.skip ? SKIP_MESSAGE : REJECT_MESSAGE) {
    void auto;
    const req = this.state.approval;
    const cur = this.interrupt;
    if (!req || req.state !== "pending" || !cur || !this.bridge) return;
    this.resolved.add(cur.key);
    this.interrupt = null;
    this.set({ approval: { ...req, state: approved ? "approved" : "rejected" } });
    const decision = approved ? { type: "approve" } : { type: "reject", message };
    this.busy = true;
    this.streaming = false;
    this.failed = false;
    this.bridge.submit(null, { decisions: Array.from({ length: cur.count }, () => decision) });
    this.rebuild();
    this.emit();
  }

  // -- internals --

  private say(text: string, role: ChatMessage["role"], queued = false) {
    const msg: ChatMessage = { id: `local-${++uid}`, role, text, shown: text.length };
    this.local.push({ after: this.wire.messages.length, queued, msg });
  }

  /** A follow-up question: a normal run on the same thread. */
  private follow(text: string) {
    this.busy = true;
    this.streaming = false;
    this.failed = false;
    this.bridge?.submit({ messages: [{ type: "human", content: text, id: crypto.randomUUID() }] });
  }

  private flushQueue() {
    const next = this.local.find((l) => l.queued);
    if (!next) return;
    this.local = this.local.filter((l) => l !== next);
    this.follow(next.msg.text);
  }

  private applyScan(scan: ScanUpdate, spots?: ScanSpot[]) {
    if (!this.rawScan) {
      const t = this.state.t;
      this.timeline = { ...this.timeline, firstMapAt: t, scanEnd: t };
      this.set({ device: "connected" });
    }
    this.rawScan = scan;
    if (spots?.length) this.set({ spots });
    this.showScan();
  }

  private applyPreview(preview: Preview | null) {
    this.preview = preview;
    this.showScan();
  }

  /** Until a result is approved, the brain shows the map the medic is asked about. */
  private showScan() {
    const raw = this.rawScan;
    if (!raw) return;
    const map = raw.status === "pending" && this.preview ? this.preview.map : raw.map;
    const old = this.state.scan;
    // Keep the same object when nothing changed, so the brain view doesn't replay its reveal.
    if (
      old &&
      old.status === raw.status &&
      old.region === raw.region &&
      old.volume_ml === raw.volume_ml &&
      old.confidence === raw.confidence &&
      old.spot === raw.spot &&
      sameGrid(old.map, map)
    )
      return;
    this.set({ scan: { ...raw, map: old && sameGrid(old.map, map) ? old.map : map } });
  }

  private applyHandoff(handoff: HandoffState | null) {
    this.handoffState = handoff ?? null;
    this.showHandoff();
  }

  /** Thread state overlaid with the Store record; true when what is shown changed. */
  private showHandoff() {
    const next = mergeHandoff(this.handoffState, this.handoffRecord);
    if (next) this.timeline = { ...this.timeline, alertSent: true };
    if (sameHandoff(next, this.state.handoff)) return false;
    this.set({ handoff: next });
    return true;
  }

  /** Tagged human messages parse once; the same object keeps the chat from repainting. */
  private tag(text: string): Tagged | null {
    if (!this.tags.has(text)) this.tags.set(text, parseTagged(text));
    return this.tags.get(text)!;
  }

  private applyActivity(item: AgentActivity) {
    if (!item || typeof item.agent !== "string") return;
    const log = this.state.activity ?? {};
    this.set({ activity: { ...log, [item.agent]: [...(log[item.agent] ?? []), item] } });
  }

  /**
   * "reset" replaces the list, "all" is the full list from thread state, "patch"
   * updates simulations and adds new ones (an agent refining). A simulation never
   * moves backwards.
   */
  private applySims(incoming: SimPatch[], mode: "reset" | "all" | "patch") {
    if (!Array.isArray(incoming)) return;
    const old = new Map(mode === "reset" ? [] : this.state.sims.map((s) => [s.id, s]));
    const merge = (p: SimPatch): Simulation | null => {
      const prev = old.get(p.id);
      // A patch for an unknown simulation only counts when it is a whole one.
      if (!prev) return p.type ? ({ score: 0, progress: 0, status: "queued", ...p, map: p.map ?? [] } as Simulation) : null;
      const status = p.status ?? prev.status;
      if (SIM_RANK[status] < SIM_RANK[prev.status]) return prev;
      const score = p.score ?? prev.score;
      const progress = status === "done" ? 1 : Math.max(p.progress ?? 0, status === prev.status ? prev.progress : 0);
      // Set once per run by the agent that picks the simulation up.
      const by = prev.by ?? p.by;
      const note = prev.note ?? p.note;
      const reading = prev.reading ?? p.reading;
      const misfit = prev.misfit ?? p.misfit;
      if (status === prev.status && score === prev.score && progress === prev.progress && by === prev.by && reading === prev.reading && misfit === prev.misfit)
        return prev;
      // Maps don't change within a run; keeping the old one saves redrawing every card.
      return { ...prev, status, score, progress, by, note, reading, misfit };
    };
    const merged = new Map<string, Simulation>();
    for (const p of incoming) {
      const s = merge(p);
      if (s) merged.set(s.id, s);
    }
    // Thread state can lag behind the events: keep what it does not list yet.
    const sims = mode === "reset" ? [...merged.values()] : [...this.state.sims.map((s) => merged.get(s.id) ?? s), ...[...merged.values()].filter((s) => !old.has(s.id))];
    if (sims.length === this.state.sims.length && sims.every((s, i) => s === this.state.sims[i])) return;

    const t = this.state.t;
    if (sims.length && this.timeline.simAt === Infinity) {
      this.timeline = { ...this.timeline, simAt: t };
      this.autoTab("simulations");
    }
    if (sims.length && this.timeline.simEnd === Infinity && sims.every((s) => s.status === "done")) {
      this.timeline = { ...this.timeline, simEnd: t };
    }
    this.set({ sims, agents: deriveAgents(sims) });
  }

  private applyInterrupt(raw: unknown) {
    const first = Array.isArray(raw) ? raw[0] : raw;
    const value = (first as { value?: { action_requests?: { name: string; description?: string }[] } } | null)?.value;
    const requests = value?.action_requests;
    if (!requests?.length) return;
    const key = (first as { id?: string }).id ?? JSON.stringify(requests);
    if (this.resolved.has(key) || this.interrupt?.key === key) return;
    const [title = "", ...rest] = (requests[0].description ?? "").split("\n");
    const rescan = requests[0].name === "request_rescan";
    const approval: ApprovalRequest = {
      id: key,
      action: title || requests[0].name,
      title: title || requests[0].name,
      detail: rest.join(" ").trim() || undefined,
      // A re-scan is something the medic does, not something they approve.
      ...(rescan ? { approveLabel: "Re-scanned", rejectLabel: "Skip" } : {}),
      state: "pending",
    };
    this.interrupt = { key, count: requests.length, skip: rescan };
    if (this.timeline.approvalAt === Infinity) this.timeline = { ...this.timeline, approvalAt: this.state.t };
    this.set({ approval });
    this.autoTab("scan");
  }

  /** Recompute plan rows and chat from the latest wire data. */
  private rebuild() {
    const { messages: wire, isLoading } = this.wire;
    const settled = !this.busy;

    // Chat: the lead agent's text and the medic's messages.
    const chat: ChatMessage[] = [];
    const locals = [...this.local];
    const flush = (upTo: number) => {
      while (locals.length && locals[0].after <= upTo) chat.push(locals.shift()!.msg);
    };
    const tools = wire.filter((m) => m.type === "tool" && m.tool_call_id);
    const answered = new Set(tools.map((m) => m.tool_call_id!));
    // Calls that failed or that the medic rejected did not happen; they get no row.
    const dropped = new Set(tools.filter((m) => m.status === "error").map((m) => m.tool_call_id!));
    // Human messages the medic did not type are tagged: the clinician's texts, a call, a channel event.
    // The bridge texts the clinician Lucid's last answer of a run they started (not after a channel event).
    let from: Tagged["role"] | "medic" = "medic";
    let answer: ChatMessage | null = null;
    const relay = () => {
      if (answer && (from === "clinician" || from === "call")) answer.relayed = true;
    };
    wire.forEach((m, i) => {
      flush(i);
      const id = m.id ?? `m-${i}`;
      if (m.type === "human") {
        const text = textOf(m.content);
        if (text === TRIGGER) return;
        relay();
        answer = null;
        const tag = this.tag(text);
        from = tag?.role ?? "medic";
        if (!tag) chat.push({ id, role: "medic", text, shown: text.length });
        else if (tag.role === "call") chat.push({ id, role: "call", text: tag.text, shown: tag.text.length, call: tag.call });
        else chat.push({ id, role: tag.role, text: tag.text, shown: tag.text.length });
      } else if (m.type === "ai") {
        const calls = m.tool_calls ?? [];
        // A result submitted without a spoken summary still deserves one in the chat.
        const summary = calls.find((c) => c.name === "submit_result")?.args?.summary;
        const text = textOf(m.content).trim() || (typeof summary === "string" ? summary.trim() : "");
        if (!text) return;
        const writing = isLoading && i === wire.length - 1 && !calls.length;
        answer = { id, role: "agent", text, shown: writing ? Math.max(0, text.length - 1) : text.length };
        chat.push(answer);
      }
    });
    if (!isLoading) relay();
    flush(Infinity);

    // Plan: to-dos, with the lead's tool calls nested under them.
    // While the agent waits for the medic it is on its last step; the pause lands before its own update does.
    const asking = this.state.approval?.state === "pending";
    const last = this.todos.length - 1;
    const steps: AgentStep[] = this.todos.map((t, i) => ({
      id: `todo-${i}`,
      kind: "todo",
      label: t.content,
      state: asking
        ? i < last ? "done" : "running"
        : t.status === "completed" ? "done" : t.status === "in_progress" ? "running" : "pending",
    }));
    const sims = this.state.sims;
    const simsDone = sims.filter((s) => s.status === "done");
    const best = simsDone.reduce<Simulation | null>((a, b) => (!a || b.score > a.score ? b : a), null);
    const rows = new Map<string, AgentStep>();
    for (const m of wire) {
      if (m.type !== "ai") continue;
      for (const call of m.tool_calls ?? []) {
        const row = toolRow(call);
        if (!row || (call.id && dropped.has(call.id))) continue;
        const running = !settled && !(call.id && answered.has(call.id));
        const prev = rows.get(row.key);
        const state: StepState = running || prev?.state === "running" ? "running" : "done";
        const detail =
          row.key === "plan" ? (sims.length ? `${sims.length}` : undefined)
          : row.key === "sim" ? (sims.length ? `${simsDone.length} of ${sims.length}` : undefined)
          : row.key === "fit" ? (best ? `best ${best.score.toFixed(2)}` : undefined)
          : row.detail;
        rows.set(row.key, { id: `tool-${row.key}`, kind: "tool", label: row.label, detail, state, parent: `todo-${row.todo}` });
      }
    }
    steps.push(...rows.values());

    const patch: Partial<DashState> = {};
    if (!sameList(chat, this.state.messages)) patch.messages = chat;
    if (!sameList(steps, this.state.steps)) patch.steps = steps;
    this.set(patch);
  }

  private tick() {
    const now = performance.now();
    // A simulated device streams mock signals for the charts; without a device they stay empty.
    const step = 1000 / SAMPLE_RATE_HZ;
    if (now - this.sampleClock > 1000) this.sampleClock = now - 1000;
    const mock = modeDef(getMode()).source === "mock";
    while (this.sampleClock + step <= now) {
      this.sampleClock += step;
      if (mock) deviceBuffer.push(deviceSample(this.sampleClock, { spot: null, moving: false, quality: "good" }));
    }
    if (!this.busy) return;
    const t = now - this.runStart;
    const tock = Math.floor(t / 1000) !== Math.floor(this.state.t / 1000);
    this.set({ t });
    if (tock) this.emit();
  }
}

// One store per browser tab. A hot reload re-runs this module whenever a file it
// imports is saved; the store (and the run it holds) survives it, with the
// class's new code swapped in.
const kept = globalThis as { __lucidLive?: LiveStore };
export const live: LiveStore = (kept.__lucidLive = kept.__lucidLive
  ? Object.setPrototypeOf(kept.__lucidLive, LiveStore.prototype)
  : new LiveStore());
