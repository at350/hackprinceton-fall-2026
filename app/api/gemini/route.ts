// Gemini brief: a hand-off note for the receiving hospital, and answers about the scan, written by Google
// Gemini from the numbers on the dashboard only. The key stays on the server (GEMINI_API_KEY in .env);
// GEMINI_MODEL picks the model, and if it is gone the first text model the key can use is taken instead.

const API = "https://generativelanguage.googleapis.com/v1beta";
let model = process.env.GEMINI_MODEL || "gemini-flash-latest";

const SYSTEM = `You are the Gemini read-out on Lucid, a handheld screener that looks for bleeding inside the skull.
A medic holds the probe on 8 spots around the head. A coil measures how well tissue conducts (blood conducts
more than brain, so a bleed changes the coil reading in dB) and near-infrared light adds a shallower check.
An AI agent runs about 100 simulated bleeds through a head model and ranks them by how well they fit the readings.

Rules:
- Use only the numbers in SCAN DATA. Never invent vitals, history, imaging or a diagnosis.
- Lucid is a screening aid, not a diagnosis. It tells a medic whether to rush someone to CT.
- If the medic has not approved a result yet, say the result is proposed, not final.
- Plain words a paramedic reads in ten seconds. No markdown tables, headings or emoji.`;

const BRIEF = `Write the pre-alert a medic would send to the receiving hospital, in four short labelled lines:
Finding: the result and its confidence.
Where: region and estimated volume, and how clearly the best fit beats the next ones.
Quality: weak spots, re-scans, or anything that makes the result less certain.
Next: what the medic should do now.`;

interface Turn {
  role: "user" | "model";
  text: string;
}

export async function POST(request: Request) {
  if (!process.env.GEMINI_API_KEY) {
    return Response.json({ error: "Set GEMINI_API_KEY in .env to turn on the Gemini brief." }, { status: 503 });
  }
  let body: { context?: unknown; question?: string; history?: Turn[] };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad JSON" }, { status: 400 });
  }
  const contents = [
    { role: "user", parts: [{ text: "SCAN DATA\n" + JSON.stringify(body.context ?? {}) }] },
    { role: "model", parts: [{ text: "I have the scan data." }] },
    ...(body.history ?? []).slice(-8).map((t) => ({
      role: t.role === "model" ? "model" : "user",
      parts: [{ text: String(t.text).slice(0, 2000) }],
    })),
    { role: "user", parts: [{ text: body.question?.trim().slice(0, 1000) || BRIEF }] },
  ];
  const payload = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents,
    generationConfig: { temperature: 0.3, maxOutputTokens: 4096 }, // room for thinking tokens too
  };
  try {
    let res = await generate(payload);
    if (res.status === 404) {
      const other = await fallbackModel();
      if (other && other !== model) {
        model = other;
        res = await generate(payload);
      }
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return Response.json({ error: `Gemini returned ${res.status}: ${err?.error?.message ?? res.statusText}` }, { status: 502 });
    }
    const data = await res.json();
    const parts: { text?: string; thought?: boolean }[] = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts.filter((p) => !p.thought).map((p) => p.text ?? "").join("").trim();
    if (!text) return Response.json({ error: "Gemini sent back no text." }, { status: 502 });
    return Response.json({ text, model });
  } catch (e) {
    return Response.json({ error: `Could not reach Gemini: ${(e as Error).message}` }, { status: 502 });
  }
}

function generate(payload: object) {
  return fetch(`${API}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY! },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(40_000),
  });
}

/** A text model this key can call, preferring the fast general ones. */
async function fallbackModel(): Promise<string | null> {
  const res = await fetch(`${API}/models?pageSize=200`, { headers: { "x-goog-api-key": process.env.GEMINI_API_KEY! } });
  if (!res.ok) return null;
  const names: string[] = ((await res.json()).models ?? [])
    .filter((m: { supportedGenerationMethods?: string[] }) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m: { name: string }) => m.name.replace(/^models\//, ""));
  for (const want of ["flash-latest", "flash", "pro"]) {
    const hit = names.filter((n) => n.includes(want) && !/image|tts|audio|live|embed/.test(n)).sort().pop();
    if (hit) return hit;
  }
  return names[0] ?? null;
}
