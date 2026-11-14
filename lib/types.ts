// ---- Device ---------------------------------------------------------------

export type SignalQuality = "good" | "weak" | "bad";

/** One device sample, ~50 Hz. */
export interface DeviceSample {
  t: number; // ms
  coil_db: number;
  nir: number;
  imu: { pitch: number; roll: number }; // degrees
  spot: number; // 0-7
  quality: SignalQuality;
}

export type DeviceStatus = "disconnected" | "connecting" | "connected" | "scanning";

// ---- Scan -----------------------------------------------------------------

// "pending": the agent has a scan but the medic has not approved a result yet (live mode).
// "rejected": the medic turned the proposed result down, so none is recorded (live mode).
export type ScanStatus = "bleed" | "uncertain" | "clear" | "pending" | "rejected";

/** Sent when a scan spot finishes. `map` is cumulative over all finished spots. */
export interface ScanUpdate {
  spot: number;
  done: true;
  map: number[][]; // 64x64, 0-1 bleed likelihood
  status: ScanStatus;
  region: string;
  volume_ml: number;
  confidence: number; // 0-1
}

export type SpotState = "next" | "current" | "done" | "rescan";

export interface ScanSpot {
  index: number;
  name: string;
  angle: number; // degrees, 0 = nose, clockwise seen from above
  state: SpotState;
  peak: number | null; // max likelihood seen at this spot
}

/** The measured scan: raw values per spot (live mode). */
export interface ScanReading {
  patient_id: string;
  taken_at: string;
  spots: { index: number; name: string; angle: number; coil_db: number; nir: number; quality: "good" | "weak" }[];
}

// ---- Simulations ----------------------------------------------------------

export type BleedType = "epidural" | "subdural" | "intraparenchymal";
export type SimStatus = "queued" | "running" | "done";
export type RegionName = "frontal" | "temporal" | "parietal" | "occipital";

// "coarse": the planned sweep. "refine": added by a region agent around a good fit.
// "review": added by the skeptic when it challenges the leading finding.
export type SimPass = "coarse" | "refine" | "review";

/** One value per scan spot. */
export interface SpotReading {
  coil_db: number[];
  nir: number[];
}

/** Simulation minus scan per spot, in units of expected error (signed). */
export interface SimMisfit {
  coil: number[];
  nir: number[];
  weight: number[]; // below 1 where contact was weak
}

export interface Simulation {
  id: string;
  type: BleedType;
  region: string; // e.g. "L temporal"
  volume_ml: number; // 5-40
  status: SimStatus;
  score: number; // 0-1, final once done
  map: number[][]; // 32x32
  agent: RegionName;
  progress: number; // 0-1 while running
  // Live mode only.
  pass?: SimPass;
  by?: string; // who ran it: a region agent or "skeptic"; unset while queued
  note?: string; // the agent's own words on why it ran this
  reading?: SpotReading; // the simulated reading, once running
  misfit?: SimMisfit; // once done
}

export interface RegionAgent {
  region: RegionName;
  done: number;
  total: number;
  state: "idle" | "running" | "done";
}

// ---- Agent ----------------------------------------------------------------

export type StepState = "pending" | "running" | "done";

export interface AgentStep {
  id: string;
  kind: "todo" | "tool";
  label: string;
  detail?: string;
  state: StepState;
  parent?: string; // id of the to-do a tool call belongs to
}

/** One thing a region agent or the skeptic did (live mode). */
export interface AgentActivity {
  agent: string;
  at: number; // epoch ms
  tool: string | null; // null: the agent's final reply, in `text`
  path?: string | null;
  note?: string | null;
  ids?: string[];
  text?: string;
}

/** A phone call with the receiving clinician, from its transcript message (live mode). */
export interface CallEntry {
  decision: "accept" | "decline" | "none";
  summary: string;
  transcript: string;
}

// "clinician": a text from the receiving clinician; "call": a phone call with them;
// "event": a hand-off channel event (not a person). The last three are live mode only.
export interface ChatMessage {
  id: string;
  role: "agent" | "medic" | "clinician" | "call" | "event";
  text: string;
  shown: number; // characters revealed so far (streaming)
  relayed?: boolean; // agent: this answer went back to the clinician by iMessage
  call?: CallEntry; // role "call"
}

// ---- Hand-off (live mode) -------------------------------------------------

// Channel status of the pre-alert, from the LangGraph Store record ["lucid", "handoffs"].
export type HandoffStatus = "sent" | "delivered" | "read" | "failed" | "no_one_on_call";
export type CallStatus = "ringing" | "answered" | "no_answer" | "failed";

export interface HandoffReply {
  decision: "accept" | "decline";
  note?: string;
  at?: string; // ISO time
  via?: "imessage" | "call";
}

export interface HandoffCall {
  status: CallStatus;
  started_at?: string; // ISO time
  summary?: string;
  duration_s?: number; // not in the contract yet; shown only when present
}

/** The pre-alert and what became of it: thread state `handoff`, overlaid with the Store record. */
export interface Handoff {
  // "update": a later scan of a patient whose hand-off was accepted; the clinician
  // was texted the change instead of a new pre-alert.
  kind: "prealert" | "update";
  to: string; // E.164 phone or iMessage handle; shown by its last four digits
  sent_at?: string; // ISO time
  delivered_at?: string; // ISO time, set by the bridge
  no_reply_at?: string; // ISO time: the bridge saw no decision in time
  channel?: "imessage";
  status: HandoffStatus;
  simulated: boolean;
  reply: HandoffReply | null;
  call: HandoffCall | null;
}

export interface ApprovalRequest {
  id: string;
  action: string;
  title?: string; // card heading
  detail?: string; // one line under it
  approveLabel?: string; // default "Approve"
  rejectLabel?: string; // default "Reject"
  state: "pending" | "approved" | "rejected";
}

// ---- Dashboard ------------------------------------------------------------

export type TabId = "scan" | "simulations";
export type ViewId = "dashboard" | "trace";

export interface DashState {
  run: number; // increments on every restart
  view: ViewId; // survives restarts
  t: number; // demo clock, ms
  playing: boolean;
  device: DeviceStatus;
  quality: SignalQuality;
  scanStartedAt: number | null;
  scanEndedAt: number | null;
  spots: ScanSpot[];
  currentSpot: number | null;
  scan: ScanUpdate | null;
  reading?: ScanReading | null; // live mode
  sims: Simulation[];
  activity?: Record<string, AgentActivity[]>; // live mode: per agent, oldest first
  agents: RegionAgent[];
  steps: AgentStep[];
  messages: ChatMessage[];
  approval: ApprovalRequest | null;
  handoff?: Handoff | null; // live mode: the pre-alert once sent
  tab: TabId;
  tabPinnedByUser: boolean;
}
