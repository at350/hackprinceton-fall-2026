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

export type ScanStatus = "bleed" | "uncertain" | "clear";

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

// ---- Simulations ----------------------------------------------------------

export type BleedType = "epidural" | "subdural" | "intraparenchymal";
export type SimStatus = "queued" | "running" | "done";
export type RegionName = "frontal" | "temporal" | "parietal" | "occipital";

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
}

export interface ChatMessage {
  id: string;
  role: "agent" | "medic";
  text: string;
  shown: number; // characters revealed so far (streaming)
}

export interface ApprovalRequest {
  id: string;
  action: string;
  state: "pending" | "approved" | "rejected";
}

// ---- Dashboard ------------------------------------------------------------

export type TabId = "scan" | "simulations";

export interface DashState {
  run: number; // increments on every restart
  t: number; // demo clock, ms
  playing: boolean;
  device: DeviceStatus;
  quality: SignalQuality;
  scanStartedAt: number | null;
  scanEndedAt: number | null;
  spots: ScanSpot[];
  currentSpot: number | null;
  scan: ScanUpdate | null;
  sims: Simulation[];
  agents: RegionAgent[];
  steps: AgentStep[];
  messages: ChatMessage[];
  approval: ApprovalRequest | null;
  tab: TabId;
  tabPinnedByUser: boolean;
}
