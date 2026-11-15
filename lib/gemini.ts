import type { DashState } from "./types";

// The Gemini brief: what Gemini is told about the scan on screen, and when to write it.
// No runtime imports, so `node --test` can load this file directly.

export interface BriefTurn {
  role: "user" | "model";
  text: string;
}

/** The scan as numbers for Gemini: verdict, spots, best-fitting simulations, the agent's words, the hand-off. */
export function briefContext(s: DashState, mode: string) {
  const sims = s.sims
    .filter((x) => x.status === "done")
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((x) => ({
      type: x.type,
      region: x.region,
      volume_ml: x.volume_ml,
      fit: round(x.score),
      ...(x.pass ? { pass: x.pass } : {}),
      ...(x.by ? { by: x.by } : {}),
      ...(x.note ? { note: x.note.slice(0, 200) } : {}),
    }));
  const agentSaid = s.messages
    .filter((m) => m.role === "agent" && m.text.trim())
    .slice(-3)
    .map((m) => m.text.slice(0, 1200));
  return {
    mode: mode === "device" ? "probe (Device mode)" : "simulated device",
    result: s.scan
      ? { status: s.scan.status, region: s.scan.region, volume_ml: s.scan.volume_ml, confidence: round(s.scan.confidence) }
      : null,
    awaiting_medic_approval: s.approval?.state === "pending" ? { title: s.approval.title, detail: s.approval.detail } : null,
    spots: s.spots.map((p) => ({ name: p.name, state: p.state, peak_likelihood: p.peak === null ? null : round(p.peak) })),
    readings: s.reading?.spots.map((p) => ({ name: p.name, coil_db: round(p.coil_db), nir: round(p.nir), quality: p.quality })) ?? null,
    baseline_scan_on_file: s.baseline ? s.baseline.taken_at ?? true : false,
    simulations_run: s.sims.length,
    best_fits: sims,
    agent_said: agentSaid,
    handoff: s.handoff
      ? { status: s.handoff.status, reply: s.handoff.reply?.decision ?? null, call: s.handoff.call?.status ?? null }
      : null,
  };
}

/** Write the brief once the agent has a result to show: when it asks the medic, or once a result stands. */
export function briefReady(s: DashState): boolean {
  if (s.approval?.state === "pending") return true;
  return !!s.scan && s.scan.status !== "pending";
}

const round = (v: number) => Math.round(v * 1000) / 1000;
