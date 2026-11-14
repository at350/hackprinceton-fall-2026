import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseTagged, lastFour, clockTime, mergeHandoff, sameHandoff, handoffBadge, handoffSteps } from "../lib/handoff.ts";

const hhmm = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const SENT = "2026-11-14T14:03:00Z";
const REPLY_AT = "2026-11-14T14:07:00Z";

const base = (over = {}) => ({ to: "+1 ... 6912", sent_at: SENT, channel: "imessage", status: "sent", simulated: false, reply: null, call: null, ...over });

describe("parseTagged", () => {
  test("clinician iMessage reply has the tag stripped", () => {
    assert.deepEqual(parseTagged("[Receiving clinician, iMessage] Accept, bay 2 ready"), { role: "clinician", text: "Accept, bay 2 ready" });
  });

  test("channel event", () => {
    assert.deepEqual(parseTagged("[Hand-off channel] Message delivered"), { role: "event", text: "Message delivered" });
  });

  test("phone call with decision, summary and transcript", () => {
    const t = parseTagged("[Receiving clinician, phone call] decision: accept. Summary: Trauma team ready. Transcript: Medic: hi\nClinician: go ahead");
    assert.equal(t.role, "call");
    assert.equal(t.text, "Trauma team ready.");
    assert.deepEqual(t.call, { decision: "accept", summary: "Trauma team ready.", transcript: "Medic: hi\nClinician: go ahead" });
  });

  test("decline and none decisions", () => {
    assert.equal(parseTagged("[Receiving clinician, phone call] decision: decline. Summary: Diverted.").call.decision, "decline");
    assert.equal(parseTagged("[Receiving clinician, phone call] decision: none. Summary: No answer.").call.decision, "none");
  });

  test("decision is case-insensitive", () => {
    assert.equal(parseTagged("[Receiving clinician, phone call] Decision: ACCEPT. Summary: ok").call.decision, "accept");
  });

  test("missing decision falls back to none", () => {
    const t = parseTagged("[Receiving clinician, phone call] Summary: just talked. Transcript: hello");
    assert.equal(t.call.decision, "none");
    assert.equal(t.call.summary, "just talked.");
    assert.equal(t.call.transcript, "hello");
  });

  test("summary without a transcript", () => {
    const t = parseTagged("[Receiving clinician, phone call] decision: accept. Summary: All set.");
    assert.equal(t.call.summary, "All set.");
    assert.equal(t.call.transcript, "");
  });

  test("an untagged medic message is null", () => {
    assert.equal(parseTagged("Patient is 54M, left MCA stroke"), null);
    assert.equal(parseTagged(""), null);
  });
});

describe("lastFour", () => {
  test("phone numbers, full and masked", () => {
    assert.equal(lastFour("+15555556912"), "…6912");
    assert.equal(lastFour("+1 ... 6912"), "…6912");
  });

  test("iMessage emails, full and masked", () => {
    assert.equal(lastFour("alice@icloud.com"), "a…@icloud.com");
    assert.equal(lastFour("a...@icloud.com"), "a…@icloud.com");
  });

  test("a plain destination is unchanged", () => {
    assert.equal(lastFour("Receiving trauma center"), "Receiving trauma center");
  });
});

describe("clockTime", () => {
  test("empty or invalid is blank", () => {
    assert.equal(clockTime(""), "");
    assert.equal(clockTime(undefined), "");
    assert.equal(clockTime(null), "");
    assert.equal(clockTime("not a date"), "");
  });

  test("a valid ISO is HH:MM in local time", () => {
    assert.equal(clockTime(SENT), hhmm(SENT));
    assert.match(clockTime(SENT), /^\d{2}:\d{2}$/);
  });
});

describe("mergeHandoff", () => {
  test("null when both inputs are null", () => {
    assert.equal(mergeHandoff(null, null), null);
    assert.equal(mergeHandoff(undefined, undefined), null);
  });

  test("record fields override thread state", () => {
    const h = mergeHandoff({ to: "+1 ... 6912", status: "sent", sent_at: "a" }, { status: "delivered", sent_at: SENT });
    assert.equal(h.status, "delivered");
    assert.equal(h.sent_at, SENT);
    assert.equal(h.channel, "imessage");
  });

  test("a null record field falls back to state", () => {
    const reply = { decision: "accept", note: "ok", at: REPLY_AT, via: "imessage" };
    const h = mergeHandoff({ status: "delivered", reply }, { status: null, reply: null });
    assert.equal(h.status, "delivered");
    assert.deepEqual(h.reply, reply);
  });

  test("to prefers the masked state value over the record's full number", () => {
    assert.equal(mergeHandoff({ to: "+1 ... 6912" }, { to: "+15555556912" }).to, "+1 ... 6912");
    assert.equal(mergeHandoff(null, { to: "+15555556912" }).to, "+15555556912");
    assert.equal(mergeHandoff({ to: null }, { to: null }).to, "");
  });

  test("unknown status becomes sent", () => {
    assert.equal(mergeHandoff({ status: "bogus" }, null).status, "sent");
    assert.equal(mergeHandoff({}, null).status, "sent");
  });

  test("every known status passes through", () => {
    for (const status of ["sent", "delivered", "read", "failed", "no_one_on_call"]) {
      assert.equal(mergeHandoff(null, { status }).status, status);
    }
  });

  test("simulated is true only for true", () => {
    assert.equal(mergeHandoff({ simulated: true }, null).simulated, true);
    assert.equal(mergeHandoff({ simulated: "yes" }, null).simulated, false);
    assert.equal(mergeHandoff(null, {}).simulated, false);
  });

  test("invalid reply shapes are null, valid ones are read", () => {
    for (const reply of ["accept", 5, [], { decision: "maybe" }, {}]) {
      assert.equal(mergeHandoff(null, { reply }).reply, null);
    }
    assert.deepEqual(mergeHandoff(null, { reply: { decision: "decline", note: "full", at: REPLY_AT, via: "call" } }).reply, {
      decision: "decline",
      note: "full",
      at: REPLY_AT,
      via: "call",
    });
    assert.equal(mergeHandoff(null, { reply: { decision: "accept", via: "carrier pigeon" } }).reply.via, undefined);
  });

  test("invalid call shapes are null, valid ones are read", () => {
    for (const call of ["ringing", 5, [], { status: "busy" }, {}]) {
      assert.equal(mergeHandoff(null, { call }).call, null);
    }
    const c = mergeHandoff(null, { call: { status: "answered", started_at: SENT, summary: "ok", duration_s: 42 } }).call;
    assert.deepEqual(c, { status: "answered", started_at: SENT, summary: "ok", duration_s: 42 });
  });

  test("duration_s is kept only when a positive number", () => {
    for (const duration_s of [0, -3, "42", null, NaN]) {
      assert.equal(mergeHandoff(null, { call: { status: "answered", duration_s } }).call.duration_s, undefined);
    }
    assert.equal(mergeHandoff(null, { call: { status: "answered", duration_s: 1.5 } }).call.duration_s, 1.5);
  });
});

describe("sameHandoff", () => {
  test("compares by value, treating null and undefined alike", () => {
    assert.equal(sameHandoff(null, undefined), true);
    assert.equal(sameHandoff(base(), base()), true);
    assert.equal(sameHandoff(base(), base({ status: "delivered" })), false);
    assert.equal(sameHandoff(base(), null), false);
  });
});

describe("handoffBadge", () => {
  const replyAt = (decision) => ({ decision, note: undefined, at: REPLY_AT, via: "imessage" });

  test("accepted and declined, with the time when known", () => {
    assert.deepEqual(handoffBadge(base({ reply: replyAt("accept") })), { key: "accepted", label: `Accepted ${hhmm(REPLY_AT)}`, tone: "primary" });
    assert.deepEqual(handoffBadge(base({ reply: replyAt("decline") })), { key: "declined", label: `Declined ${hhmm(REPLY_AT)}`, tone: "warn" });
    assert.equal(handoffBadge(base({ reply: { decision: "accept" } })).label, "Accepted");
    assert.equal(handoffBadge(base({ reply: { decision: "decline" } })).label, "Declined");
  });

  test("a reply beats everything", () => {
    const h = base({ status: "no_one_on_call", simulated: true, call: { status: "ringing" }, reply: replyAt("accept") });
    assert.equal(handoffBadge(h).key, "accepted");
  });

  test("no_one_on_call beats failed, simulated and calls", () => {
    assert.equal(handoffBadge(base({ status: "no_one_on_call", simulated: true, call: { status: "ringing" } })).key, "no_one_on_call");
  });

  test("failed beats simulated and calls", () => {
    assert.deepEqual(handoffBadge(base({ status: "failed", simulated: true, call: { status: "ringing" } })), { key: "failed", label: "Not delivered", tone: "warn" });
  });

  test("simulated beats call states and delivery", () => {
    assert.deepEqual(handoffBadge(base({ simulated: true, status: "read", call: { status: "answered" } })), { key: "simulated", label: "Simulated", tone: "muted" });
  });

  test("call states beat read and delivered", () => {
    assert.deepEqual(handoffBadge(base({ status: "read", call: { status: "ringing" } })), { key: "calling", label: "Calling", tone: "primary" });
    assert.deepEqual(handoffBadge(base({ status: "read", call: { status: "answered" } })), { key: "on_call", label: "Call answered", tone: "text" });
    assert.deepEqual(handoffBadge(base({ status: "read", call: { status: "no_answer" } })), { key: "no_answer", label: "No answer", tone: "warn" });
    assert.deepEqual(handoffBadge(base({ status: "read", call: { status: "failed" } })), { key: "call_failed", label: "Call failed", tone: "warn" });
  });

  test("read, delivered, sent", () => {
    assert.deepEqual(handoffBadge(base({ status: "read" })), { key: "read", label: "Read", tone: "text" });
    assert.deepEqual(handoffBadge(base({ status: "delivered" })), { key: "delivered", label: "Delivered", tone: "text" });
    assert.deepEqual(handoffBadge(base()), { key: "sent", label: "Sent", tone: "text" });
  });
});

describe("handoffSteps", () => {
  const ids = (steps) => steps.map((s) => s.id);
  const find = (steps, id) => steps.find((s) => s.id === id);

  test("sent only: delivered running, reply pending, call if no reply", () => {
    const steps = handoffSteps(base());
    assert.deepEqual(ids(steps), ["sent", "delivered", "reply", "call"]);
    assert.deepEqual(steps[0], { id: "sent", label: "Sent", state: "done", detail: hhmm(SENT) });
    assert.equal(find(steps, "delivered").state, "running");
    assert.deepEqual(find(steps, "reply"), { id: "reply", label: "Reply: accept or decline", state: "pending", detail: undefined });
    assert.deepEqual(find(steps, "call"), { id: "call", label: "Phone call", state: "pending", detail: "if no reply" });
  });

  test("sent with no timestamp has no detail", () => {
    assert.equal(handoffSteps(base({ sent_at: undefined }))[0].detail, undefined);
  });

  test("delivered: reply is running and waiting", () => {
    const steps = handoffSteps(base({ status: "delivered" }));
    assert.equal(find(steps, "delivered").state, "done");
    assert.equal(find(steps, "reply").state, "running");
    assert.equal(find(steps, "reply").detail, "waiting");
    assert.equal(find(steps, "call").detail, "if no reply");
  });

  test("a Read step appears only when status is read", () => {
    assert.equal(find(handoffSteps(base()), "read"), undefined);
    assert.equal(find(handoffSteps(base({ status: "delivered" })), "read"), undefined);
    const steps = handoffSteps(base({ status: "read" }));
    assert.deepEqual(ids(steps), ["sent", "delivered", "read", "reply", "call"]);
    assert.equal(find(steps, "read").state, "done");
  });

  test("failed: Sent then Not delivered, nothing else", () => {
    const steps = handoffSteps(base({ status: "failed" }));
    assert.deepEqual(steps.map((s) => [s.id, s.label, s.state]), [
      ["sent", "Sent", "done"],
      ["delivered", "Not delivered", "failed"],
    ]);
  });

  test("no_one_on_call: a single failed step", () => {
    assert.deepEqual(handoffSteps(base({ status: "no_one_on_call" })), [{ id: "sent", label: "No one on call", state: "failed", detail: "use the radio" }]);
  });

  test("simulated: a single step", () => {
    assert.deepEqual(handoffSteps(base({ simulated: true })), [{ id: "sent", label: "Simulated, not sent", state: "done", detail: hhmm(SENT) }]);
  });

  test("reply by text: no call step", () => {
    const steps = handoffSteps(base({ status: "delivered", reply: { decision: "accept", at: REPLY_AT, via: "imessage" } }));
    assert.deepEqual(ids(steps), ["sent", "delivered", "reply"]);
    assert.deepEqual(find(steps, "reply"), { id: "reply", label: "Accepted by text", state: "done", detail: hhmm(REPLY_AT) });
    assert.equal(find(steps, "delivered").state, "done");
  });

  test("a decline is a failed step", () => {
    const reply = find(handoffSteps(base({ reply: { decision: "decline", via: "imessage" } })), "reply");
    assert.equal(reply.label, "Declined by text");
    assert.equal(reply.state, "failed");
    assert.equal(reply.detail, undefined);
  });

  test("a reply with no via has no suffix", () => {
    assert.equal(find(handoffSteps(base({ reply: { decision: "accept" } })), "reply").label, "Accepted");
  });

  test("with a call, the call step comes before the reply step", () => {
    const steps = handoffSteps(base({ call: { status: "answered", started_at: SENT }, reply: { decision: "accept", at: REPLY_AT, via: "call" } }));
    assert.deepEqual(ids(steps), ["sent", "delivered", "call", "reply"]);
    assert.equal(find(steps, "reply").label, "Accepted by call");
    assert.equal(find(steps, "delivered").state, "done");
  });

  test("call ringing", () => {
    const steps = handoffSteps(base({ call: { status: "ringing", started_at: SENT } }));
    assert.deepEqual(find(steps, "call"), { id: "call", label: "Phone call", state: "running", detail: "ringing" });
    // While a call is live the reply is pending, not "waiting".
    assert.deepEqual(find(steps, "reply"), { id: "reply", label: "Reply: accept or decline", state: "pending", detail: undefined });
    assert.deepEqual(ids(steps), ["sent", "delivered", "call", "reply"]);
  });

  test("call answered", () => {
    const c = find(handoffSteps(base({ call: { status: "answered", started_at: SENT } })), "call");
    assert.deepEqual(c, { id: "call", label: "Phone call, answered", state: "done", detail: hhmm(SENT) });
  });

  test("call no_answer and failed", () => {
    const na = find(handoffSteps(base({ call: { status: "no_answer", started_at: SENT } })), "call");
    assert.deepEqual(na, { id: "call", label: "Phone call, no answer", state: "failed", detail: hhmm(SENT) });
    const f = find(handoffSteps(base({ call: { status: "failed" } })), "call");
    assert.deepEqual(f, { id: "call", label: "Phone call failed", state: "failed", detail: undefined });
  });
});
