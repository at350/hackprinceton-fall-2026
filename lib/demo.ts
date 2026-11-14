import { DEMO_LENGTH_MS, SAMPLE_RATE_HZ } from "./config";
import {
  REGIONS,
  deviceBuffer,
  deviceSample,
  initialAgents,
  initialSims,
  initialSpots,
  scanMap,
  simDuration,
  spotPeak,
} from "./mock";
import type {
  AgentStep,
  ChatMessage,
  DashState,
  ScanStatus,
  Simulation,
  TabId,
} from "./types";

// ---- Story timing (demo clock, ms) ---------------------------------------

const CONNECTING_AT = 1_200;
const CONNECTED_AT = 3_200;
const SCAN_AT = 8_000;
const SLOT_MS = 5_500; // one spot: 4.5 s dwell + 1 s move
const DWELL_MS = 4_500;
const SIM_AT = 59_000;
const SIM_SPAN = 26_000; // every region agent finishes its 6 runs in this time
const APPROVAL_AT = 96_500;
const AUTO_APPROVE_MS = 15_000; // wall time the story waits for the medic
const CHARS_PER_MS = 0.06;

// Spot visit order; spot 5 is visited twice (first pass has weak contact).
const SLOTS = [0, 1, 2, 3, 4, 5, 5, 6, 7];
const SCAN_END = SCAN_AT + (SLOTS.length - 1) * SLOT_MS + DWELL_MS;

/** Story milestones, for views that show timing (the agent trace). */
export const TIMELINE = {
  connectedAt: CONNECTED_AT,
  scanAt: SCAN_AT,
  firstMapAt: SCAN_AT + DWELL_MS,
  scanEnd: SCAN_END,
  simAt: SIM_AT,
  simEnd: SIM_AT + SIM_SPAN,
  approvalAt: APPROVAL_AT,
};

// Result card after each slot finishes.
const SLOT_RESULT: { status: ScanStatus; region: string; volume_ml: number; confidence: number }[] = [
  { status: "clear", region: "None", volume_ml: 0, confidence: 0.41 },
  { status: "clear", region: "None", volume_ml: 0, confidence: 0.46 },
  { status: "clear", region: "None", volume_ml: 0, confidence: 0.52 },
  { status: "clear", region: "None", volume_ml: 0, confidence: 0.55 },
  { status: "clear", region: "None", volume_ml: 0, confidence: 0.57 },
  { status: "uncertain", region: "L parietal", volume_ml: 0, confidence: 0.34 },
  { status: "uncertain", region: "L parietal", volume_ml: 11, confidence: 0.52 },
  { status: "bleed", region: "L temporal", volume_ml: 19, confidence: 0.78 },
  { status: "bleed", region: "L temporal", volume_ml: 21, confidence: 0.81 },
];

// Per-agent schedule: each region agent runs its 6 hypotheses back to back.
const SIM_TEMPLATE = initialSims();
const SIM_WINDOWS = (() => {
  const windows = new Map<string, { start: number; end: number }>();
  for (const region of REGIONS) {
    const sims = SIM_TEMPLATE.filter((s) => s.agent === region);
    const raw = sims.map((s) => simDuration(SIM_TEMPLATE.indexOf(s)));
    const total = raw.reduce((a, b) => a + b, 0);
    let at = SIM_AT;
    sims.forEach((s, j) => {
      const d = (raw[j] * SIM_SPAN) / total;
      windows.set(s.id, { start: at, end: at + d });
      at += d;
    });
  }
  return windows;
})();

const TODOS: AgentStep[] = [
  { id: "todo-scan", kind: "todo", label: "Collect 8 scan spots", state: "pending" },
  { id: "todo-map", kind: "todo", label: "Build bleed-likelihood map", state: "pending" },
  { id: "todo-sims", kind: "todo", label: "Run region simulations", state: "pending" },
  { id: "todo-rank", kind: "todo", label: "Rank best-fit hypothesis", state: "pending" },
  { id: "todo-approve", kind: "todo", label: "Ask medic to confirm", state: "pending" },
];

function initialState(run = 0): DashState {
  return {
    run,
    t: 0,
    playing: true,
    device: "disconnected",
    quality: "bad",
    scanStartedAt: null,
    scanEndedAt: null,
    spots: initialSpots(),
    currentSpot: null,
    scan: null,
    sims: SIM_TEMPLATE.map((s) => ({ ...s })),
    agents: initialAgents(),
    steps: [],
    messages: [],
    approval: null,
    tab: "scan",
    tabPinnedByUser: false,
  };
}

type StoryEvent = { at: number; run: (s: DemoStore) => void };

// ---- Agent copy -----------------------------------------------------------

const COPY = {
  hello:
    "Device connected. I'll guide an 8-spot scan around the head. Start at the frontal spot and hold the coil still for about 5 seconds per spot.",
  weak:
    "Weak contact at L parietal, so that read is uncertain. Part the hair, press the coil flat, and re-scan this spot.",
  asym:
    "Clear asymmetry on the left. Coil signal is about 4 dB lower than the right side and NIR absorption is up at L temporal. I'll finish the last spot, then start the region agents.",
  sims:
    "Scan complete. Starting 4 region agents to test 24 bleed hypotheses against the map.",
  result:
    "Best fit: epidural hematoma, left temporal, about 22 mL (fit 0.91). It explains the coil drop at spots 6 and 7 and the raised NIR absorption. Next best is subdural, left temporal, 25 mL (0.84). Right-sided hypotheses fit poorly (below 0.12).",
  ask: "I recommend marking this scan Bleed likely and sending a pre-alert with the map and best fit to the receiving trauma center. Approve?",
  approved:
    "Approved. Pre-alert sent with the likelihood map, best-fit summary and scan log. Re-scan in 10 minutes to check for growth.",
  autoApproved:
    "Approved (demo auto-approve). Pre-alert sent with the likelihood map, best-fit summary and scan log. Re-scan in 10 minutes to check for growth.",
  rejected:
    "Rejected. Nothing was sent. I'll keep the result on screen. Say \"re-scan\" to repeat the left-side spots.",
};

function replyTo(text: string) {
  const q = text.toLowerCase();
  if (q.includes("volume") || q.includes("ml") || q.includes("size"))
    return "Volume comes from the best-fit simulation: about 22 mL, with a plausible range of 18 to 27 mL across the top three fits.";
  if (q.includes("why") || q.includes("how") || q.includes("sure") || q.includes("confiden"))
    return "Two signals agree: the coil reads about 4 dB lower over the left temporal spots, and NIR absorption rises there. The epidural model reproduces both; the others miss the coil drop.";
  if (q.includes("scan"))
    return "To re-scan, place the coil on L parietal, then L temporal, then L frontal. I'll merge the new reads into the map.";
  return "Noted. This is a screening aid, not a diagnosis. Confirm with CT as soon as the patient arrives.";
}

// ---- Store ----------------------------------------------------------------

let uid = 0;
const nextId = (p: string) => `${p}-${++uid}`;

export class DemoStore {
  state: DashState = initialState();
  private listeners = new Set<() => void>();
  private events: StoryEvent[] = buildStory();
  private applied = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastWall = 0;
  private sampleClock = 0;
  private holdDeadline = 0;
  private generation = 0;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getState = () => this.state;

  set(patch: Partial<DashState>) {
    this.state = { ...this.state, ...patch };
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  start() {
    if (this.timer) return;
    this.lastWall = performance.now();
    this.sampleClock = this.lastWall;
    this.timer = setInterval(() => this.tick(), 50);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  restart() {
    this.generation++;
    this.state = initialState(this.state.run + 1);
    this.applied = 0;
    deviceBuffer.clear();
    this.emit();
  }

  /** Jump to a point in the story (dev aid: window.__demo.seek(60000)). */
  seek(ms: number) {
    this.restart();
    while (this.applied < this.events.length && this.events[this.applied].at <= ms) {
      const e = this.events[this.applied++];
      this.set({ t: e.at });
      e.run(this);
    }
    this.set({ t: ms });
    this.updateSims(ms);
    this.set({ messages: this.state.messages.map((m) => ({ ...m, shown: m.text.length })) });
    this.emit();
  }

  togglePause() {
    this.set({ playing: !this.state.playing });
    this.emit();
  }

  setTab(tab: TabId) {
    this.set({ tab, tabPinnedByUser: true });
    this.emit();
  }

  autoTab(tab: TabId) {
    if (!this.state.tabPinnedByUser) this.set({ tab });
  }

  // -- agent helpers --

  say(text: string, role: ChatMessage["role"] = "agent") {
    const msg: ChatMessage = { id: nextId("msg"), role, text, shown: role === "medic" ? text.length : 0 };
    this.set({ messages: [...this.state.messages, msg] });
  }

  step(id: string, patch: Partial<AgentStep>) {
    this.set({ steps: this.state.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  }

  addStep(step: AgentStep) {
    this.set({ steps: [...this.state.steps, step] });
  }

  sendMedic(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (/^re-?scan/i.test(trimmed) && this.state.approval?.state === "rejected") {
      this.say(trimmed, "medic");
      this.emit();
      return void setTimeout(() => this.restart(), 600);
    }
    this.say(trimmed, "medic");
    this.emit();
    const gen = this.generation;
    setTimeout(() => {
      if (gen !== this.generation) return;
      this.say(replyTo(trimmed));
      this.emit();
    }, 700);
  }

  resolveApproval(approved: boolean, auto = false) {
    const req = this.state.approval;
    if (!req || req.state !== "pending") return;
    this.set({ approval: { ...req, state: approved ? "approved" : "rejected" } });
    this.step("todo-approve", { state: "done" });
    if (approved) {
      this.addStep({ id: "tool-alert", kind: "tool", label: "Sending pre-alert", detail: "trauma center", state: "done" });
      this.say(auto ? COPY.autoApproved : COPY.approved);
    } else {
      this.say(COPY.rejected);
    }
    this.emit();
  }

  // -- clock --

  private tick() {
    const now = performance.now();
    const dt = Math.min(250, now - this.lastWall);
    this.lastWall = now;
    const s = this.state;

    // Device stream runs on wall time, independent of the story clock.
    if (s.device === "disconnected") {
      this.sampleClock = now;
    } else {
      const step = 1000 / SAMPLE_RATE_HZ;
      const slotT = s.t - SCAN_AT;
      const moving = s.device === "scanning" && slotT % SLOT_MS > DWELL_MS;
      while (this.sampleClock + step <= now) {
        this.sampleClock += step;
        deviceBuffer.push(
          deviceSample(this.sampleClock, { spot: s.currentSpot, moving, quality: s.quality }),
        );
      }
    }

    if (!s.playing) return;

    // Hold the story while waiting for the medic.
    const holding = s.approval?.state === "pending";
    if (holding && now > this.holdDeadline) this.resolveApproval(true, true);

    if (!holding) {
      const t = s.t + dt;
      this.set({ t });
      while (this.applied < this.events.length && this.events[this.applied].at <= t) {
        this.events[this.applied++].run(this);
      }
      this.updateSims(t);
      if (t >= DEMO_LENGTH_MS) {
        this.restart();
        return;
      }
    }

    // Stream agent text.
    const streaming = this.state.messages.find((m) => m.shown < m.text.length);
    if (streaming) {
      const shown = Math.min(streaming.text.length, streaming.shown + dt * CHARS_PER_MS * 1.0 + 0.5);
      this.set({
        messages: this.state.messages.map((m) => (m === streaming ? { ...m, shown } : m)),
      });
    }

    this.emit();
  }

  startHold() {
    this.holdDeadline = performance.now() + AUTO_APPROVE_MS;
  }

  private updateSims(t: number) {
    if (t < SIM_AT) return;
    let changed = false;
    const sims: Simulation[] = this.state.sims.map((sim) => {
      const w = SIM_WINDOWS.get(sim.id)!;
      const status = t >= w.end ? "done" : t >= w.start ? "running" : "queued";
      const progress = status === "done" ? 1 : status === "running" ? (t - w.start) / (w.end - w.start) : 0;
      if (status === sim.status && (status !== "running" || Math.abs(progress - sim.progress) < 0.01)) return sim;
      changed = true;
      return { ...sim, status, progress };
    });
    if (!changed) return;
    const agents = this.state.agents.map((a) => {
      const mine = sims.filter((x) => x.agent === a.region);
      const done = mine.filter((x) => x.status === "done").length;
      return { ...a, done, state: done === a.total ? "done" : "running" } as const;
    });
    const doneCount = sims.filter((x) => x.status === "done").length;
    const best = sims.filter((x) => x.status === "done").sort((a, b) => b.score - a.score)[0];
    this.set({ sims, agents });
    this.step("tool-sim", { detail: `${doneCount} of ${sims.length}` });
    if (best) this.step("tool-fit", { detail: `best ${best.score.toFixed(2)}`, state: doneCount === sims.length ? "done" : "running" });
  }
}

// ---- The story ------------------------------------------------------------

function buildStory(): StoryEvent[] {
  const ev: StoryEvent[] = [];
  const at = (t: number, run: (s: DemoStore) => void) => ev.push({ at: t, run });

  at(CONNECTING_AT, (s) => s.set({ device: "connecting", quality: "bad" }));
  at(CONNECTED_AT, (s) => s.set({ device: "connected", quality: "good" }));
  at(CONNECTED_AT + 1_000, (s) => {
    s.set({ steps: TODOS.map((x) => ({ ...x })) });
    s.say(COPY.hello);
  });

  SLOTS.forEach((spot, k) => {
    const start = SCAN_AT + k * SLOT_MS;
    const weak = k === 5;
    at(start, (s) => {
      const st = s.state;
      if (k === 0) {
        s.set({ device: "scanning", scanStartedAt: st.t });
        s.step("todo-scan", { state: "running" });
        s.addStep({ id: "tool-read", kind: "tool", label: "Reading scan spot", detail: "1 of 8", state: "running" });
      }
      s.set({
        currentSpot: spot,
        quality: weak ? "weak" : "good",
        spots: st.spots.map((p) => (p.index === spot ? { ...p, state: "current" } : p)),
      });
      s.step("tool-read", { detail: `${Math.min(8, spot + 1)} of 8${k === 6 ? ", re-scan" : ""}` });
    });
    at(start + DWELL_MS, (s) => {
      const st = s.state;
      const doneSpots = st.spots.filter((p) => p.state === "done").map((p) => p.index);
      const spots = st.spots.map((p) =>
        p.index === spot ? { ...p, state: weak ? ("rescan" as const) : ("done" as const), peak: weak ? null : spotPeak(spot) } : p,
      );
      const map = weak ? st.scan?.map ?? scanMap([]) : scanMap([...doneSpots, spot]);
      s.set({ spots, scan: { spot, done: true, map, ...SLOT_RESULT[k] }, quality: "good" });
      if (k === 0) {
        s.step("todo-map", { state: "running" });
        s.addStep({ id: "tool-map", kind: "tool", label: "Updating likelihood map", detail: "1 of 8 spots", state: "running" });
      } else {
        s.step("tool-map", { detail: `${spots.filter((p) => p.state === "done").length} of 8 spots` });
      }
      if (weak) s.say(COPY.weak);
      if (k === 7) s.say(COPY.asym);
    });
  });

  at(SCAN_END + 100, (s) => {
    s.set({ device: "connected", scanEndedAt: s.state.t, currentSpot: null });
    s.step("todo-scan", { state: "done" });
    s.step("todo-map", { state: "done" });
    s.step("tool-read", { state: "done", detail: "8 of 8" });
    s.step("tool-map", { state: "done" });
  });

  at(SIM_AT - 800, (s) => {
    s.say(COPY.sims);
    s.step("todo-sims", { state: "running" });
    s.addStep({ id: "tool-sim", kind: "tool", label: "Running simulations", detail: "0 of 24", state: "running" });
    s.addStep({ id: "tool-fit", kind: "tool", label: "Scoring fit", detail: "waiting", state: "pending" });
    s.set({ agents: s.state.agents.map((a) => ({ ...a, state: "running" })) });
  });
  at(SIM_AT - 300, (s) => s.autoTab("simulations"));

  at(SIM_AT + SIM_SPAN + 300, (s) => {
    s.step("todo-sims", { state: "done" });
    s.step("tool-sim", { state: "done" });
    s.step("todo-rank", { state: "done" });
    s.say(COPY.result);
  });

  at(SIM_AT + SIM_SPAN + 6_500, (s) => {
    s.autoTab("scan");
    const scan = s.state.scan;
    if (scan) s.set({ scan: { ...scan, status: "bleed", region: "L temporal", volume_ml: 22, confidence: 0.91 } });
  });

  at(APPROVAL_AT, (s) => {
    s.step("todo-approve", { state: "running" });
    s.say(COPY.ask);
    s.set({ approval: { id: nextId("approval"), action: "Send pre-alert to trauma center", state: "pending" } });
    s.startHold();
  });

  return ev.sort((a, b) => a.at - b.at);
}

// One store per browser tab.
export const demo = typeof window !== "undefined" ? new DemoStore() : (null as unknown as DemoStore);
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  (window as unknown as { __demo: DemoStore }).__demo = demo;
}
