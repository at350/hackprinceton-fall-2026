import type { CallEntry, Handoff, HandoffCall, HandoffReply, HandoffStatus } from "./types";

// Live mode: the hospital hand-off. The pre-alert's channel status lives in the
// LangGraph Store (["lucid", "handoffs"], key = thread id); the clinician's texts,
// call transcripts and channel events arrive as tagged human messages on the thread.
// No runtime imports, so `node --test` can load this file directly.

export const HANDOFF_NAMESPACE = ["lucid", "handoffs"];

const CLINICIAN_TAG = "[Receiving clinician, iMessage]";
const CALL_TAG = "[Receiving clinician, phone call]";
const CHANNEL_TAG = "[Hand-off channel]";

export type Tagged =
  | { role: "clinician"; text: string }
  | { role: "call"; text: string; call: CallEntry }
  | { role: "event"; text: string };

/** A human message that did not come from the medic, with its tag stripped; null for the medic's own. */
export function parseTagged(content: string): Tagged | null {
  const text = content.trim();
  if (text.startsWith(CLINICIAN_TAG)) return { role: "clinician", text: text.slice(CLINICIAN_TAG.length).trim() };
  if (text.startsWith(CHANNEL_TAG)) return { role: "event", text: text.slice(CHANNEL_TAG.length).trim() };
  if (text.startsWith(CALL_TAG)) {
    const body = text.slice(CALL_TAG.length).trim();
    // "decision: accept|decline|none. Summary: ... Transcript: ..."
    const decision = /^decision:\s*(accept|decline|none)\b/i.exec(body)?.[1]?.toLowerCase() as CallEntry["decision"] | undefined;
    const summary = /Summary:\s*([\s\S]*?)\s*(?:Transcript:|$)/i.exec(body)?.[1]?.trim() ?? "";
    const transcript = /Transcript:\s*([\s\S]*)$/i.exec(body)?.[1]?.trim() ?? "";
    return { role: "call", text: summary || body, call: { decision: decision ?? "none", summary, transcript } };
  }
  return null;
}

/** "…4821" for a phone number, "a…@icloud.com" for an iMessage email; anything else as it is. */
export function lastFour(to: string): string {
  const digits = to.replace(/\D/g, "");
  if (digits.length >= 4) return `…${digits.slice(-4)}`;
  const [name, domain] = to.split("@");
  if (domain && name) return `${name.replace(/\.+$/, "").slice(0, 1)}…@${domain}`;
  return to;
}

/** "14:03" in local time, or "" when the time is missing or unreadable. */
export function clockTime(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const STATUSES: HandoffStatus[] = ["sent", "delivered", "read", "failed", "no_one_on_call"];

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

function readReply(v: unknown): HandoffReply | null {
  const r = obj(v);
  if (!r || (r.decision !== "accept" && r.decision !== "decline")) return null;
  return { decision: r.decision, note: str(r.note), at: str(r.at), via: r.via === "call" ? "call" : r.via === "imessage" ? "imessage" : undefined };
}

function readCall(v: unknown): HandoffCall | null {
  const c = obj(v);
  if (!c || !["ringing", "answered", "no_answer", "failed"].includes(c.status as string)) return null;
  return {
    status: c.status as HandoffCall["status"],
    started_at: str(c.started_at),
    summary: str(c.summary),
    duration_s: typeof c.duration_s === "number" && c.duration_s > 0 ? c.duration_s : undefined,
  };
}

/**
 * The hand-off as shown: thread state `handoff` (what the tool sent) overlaid with
 * the Store record (delivery, reply and call, which change outside any run).
 * Null until the pre-alert has gone out.
 */
export function mergeHandoff(state: unknown, record: unknown): Handoff | null {
  const s = obj(state);
  const r = obj(record);
  if (!s && !r) return null;
  const pick = (k: string) => (r && r[k] !== undefined && r[k] !== null ? r[k] : s?.[k]);
  const status = pick("status");
  return {
    kind: s?.kind === "update" || str(r?.update_of) ? "update" : "prealert",
    // The state's copy is already masked; the Store record has the full handle.
    to: str(s?.to) ?? str(r?.to) ?? "",
    sent_at: str(pick("sent_at")),
    delivered_at: str(r?.delivered_at),
    no_reply_at: str(r?.no_reply_at),
    channel: "imessage",
    status: STATUSES.includes(status as HandoffStatus) ? (status as HandoffStatus) : "sent",
    simulated: pick("simulated") === true,
    reply: readReply(pick("reply")),
    call: readCall(pick("call")),
  };
}

export function sameHandoff(a: Handoff | null | undefined, b: Handoff | null | undefined) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// ---- What the hand-off row shows -----------------------------------------

export type BadgeKey =
  | "simulated"
  | "sent"
  | "delivered"
  | "read"
  | "failed"
  | "no_one_on_call"
  | "accepted"
  | "declined"
  | "calling"
  | "on_call"
  | "no_answer"
  | "call_failed"
  | "no_reply";
export type Tone = "text" | "primary" | "warn" | "muted";

/** The one status the collapsed row shows: the furthest the hand-off has got. */
export function handoffBadge(h: Handoff): { key: BadgeKey; label: string; tone: Tone } {
  // An update only tells them what changed: its own delivery is the status; the decision stands from before.
  if (h.kind === "update") {
    if (h.status === "failed") return { key: "failed", label: "Not delivered", tone: "warn" };
    if (h.status === "delivered" || h.status === "read") return { key: "delivered", label: "Delivered", tone: "text" };
    return { key: "sent", label: "Sent", tone: "text" };
  }
  const at = clockTime(h.reply?.at);
  if (h.reply?.decision === "accept") return { key: "accepted", label: at ? `Accepted ${at}` : "Accepted", tone: "primary" };
  if (h.reply?.decision === "decline") return { key: "declined", label: at ? `Declined ${at}` : "Declined", tone: "warn" };
  if (h.status === "no_one_on_call") return { key: "no_one_on_call", label: "No one on call", tone: "warn" };
  if (h.status === "failed") return { key: "failed", label: "Not delivered", tone: "warn" };
  if (h.simulated) return { key: "simulated", label: "Simulated", tone: "muted" };
  if (h.call?.status === "ringing") return { key: "calling", label: "Calling", tone: "primary" };
  if (h.call?.status === "answered") return { key: "on_call", label: "Call answered", tone: "text" };
  if (h.call?.status === "no_answer") return { key: "no_answer", label: "No answer", tone: "warn" };
  if (h.call?.status === "failed") return { key: "call_failed", label: "Call failed", tone: "warn" };
  if (h.no_reply_at) return { key: "no_reply", label: "No reply", tone: "warn" };
  if (h.status === "read") return { key: "read", label: "Read", tone: "text" };
  if (h.status === "delivered") return { key: "delivered", label: "Delivered", tone: "text" };
  return { key: "sent", label: "Sent", tone: "text" };
}

export type HandoffStepState = "done" | "running" | "pending" | "failed";
export interface HandoffStep {
  id: "sent" | "delivered" | "read" | "silence" | "reply" | "call";
  label: string;
  state: HandoffStepState;
  detail?: string;
}

/** The expanded list, in time order: sent, delivered, read, silence, the call when there is or may be one, the reply. */
export function handoffSteps(h: Handoff): HandoffStep[] {
  const sentAt = clockTime(h.sent_at);
  if (h.status === "no_one_on_call") return [{ id: "sent", label: "No one on call", state: "failed", detail: "use the radio" }];
  if (h.simulated) return [{ id: "sent", label: "Simulated, not sent", state: "done", detail: sentAt || undefined }];

  const replied = !!h.reply;
  const failed = h.status === "failed";
  const delivered = h.status === "delivered" || h.status === "read" || replied || !!h.call;
  const read = h.status === "read";
  const deliveredAt = clockTime(h.delivered_at);
  const steps: HandoffStep[] = [
    { id: "sent", label: "Sent", state: "done", detail: sentAt || undefined },
    failed
      ? { id: "delivered", label: "Not delivered", state: "failed" }
      : { id: "delivered", label: "Delivered", state: delivered ? "done" : "running", detail: deliveredAt || undefined },
  ];
  if (h.kind === "update") {
    // The decision on the first scan stands; this scan only told them what changed.
    if (!h.reply) return steps;
    const accepted = h.reply.decision === "accept";
    const at = clockTime(h.reply.at);
    return [{ id: "reply", label: accepted ? "Accepted on the first scan" : "Declined on the first scan", state: accepted ? "done" : "failed", detail: at || undefined }, ...steps];
  }
  if (failed) return steps;
  // Photon reports no read receipts on a shared line, so Read shows only if one ever arrives.
  if (read) steps.push({ id: "read", label: "Read", state: "done" });
  if (h.no_reply_at) steps.push({ id: "silence", label: "No reply", state: "failed", detail: clockTime(h.no_reply_at) || undefined });

  const at = clockTime(h.reply?.at);
  const by = h.reply?.via === "call" ? " by call" : h.reply?.via === "imessage" ? " by text" : "";
  const reply: HandoffStep = h.reply
    ? { id: "reply", label: h.reply.decision === "accept" ? `Accepted${by}` : `Declined${by}`, state: h.reply.decision === "accept" ? "done" : "failed", detail: at || undefined }
    : { id: "reply", label: "Reply: accept or decline", state: delivered && !h.call ? "running" : "pending", detail: delivered && !h.call ? "waiting" : undefined };

  const c = h.call;
  if (!c) {
    // A call only follows silence; once they have replied, or silence passed without one, there will be none.
    steps.push(reply);
    if (!h.reply && !h.no_reply_at) steps.push({ id: "call", label: "Phone call", state: "pending", detail: "if no reply" });
    return steps;
  }
  // The call came before whatever was decided on it.
  const started = clockTime(c.started_at);
  if (c.status === "ringing") steps.push({ id: "call", label: "Phone call", state: "running", detail: "ringing" });
  else if (c.status === "answered") steps.push({ id: "call", label: "Phone call, answered", state: "done", detail: started || undefined });
  else steps.push({ id: "call", label: c.status === "no_answer" ? "Phone call, no answer" : "Phone call failed", state: "failed", detail: started || undefined });
  steps.push(reply);
  return steps;
}
