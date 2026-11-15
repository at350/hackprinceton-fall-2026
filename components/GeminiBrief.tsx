"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { type BriefTurn, briefContext, briefReady } from "@/lib/gemini";
import { getMode } from "@/lib/mode";
import { store } from "@/lib/store";
import { useDash } from "@/lib/useDash";
import { IconArrowUp } from "./icons";
import { EASE_ENTER } from "./ui";

/** Google Gemini's sparkle, in Gemini blue. */
function Spark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2c.6 5.3 4.7 9.4 10 10-5.3.6-9.4 4.7-10 10-.6-5.3-4.7-9.4-10-10 5.3-.6 9.4-4.7 10-10z" fill="#8ab4f8" />
    </svg>
  );
}

async function ask(question: string | null, history: BriefTurn[]): Promise<{ text?: string; model?: string; error?: string }> {
  try {
    const res = await fetch("/api/gemini", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: briefContext(store.getState(), getMode()), question, history }),
    });
    return await res.json();
  } catch (e) {
    return { error: `Could not reach the dashboard server: ${(e as Error).message}` };
  }
}

/** The hand-off note Gemini writes once the agent has a result, and questions to Gemini about the scan. */
export function GeminiBrief() {
  const ready = useDash(briefReady);
  const [turns, setTurns] = useState<BriefTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const asked = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);

  async function run(question: string | null) {
    setBusy(true);
    setError(null);
    const history = question ? turns : [];
    if (question) setTurns([...turns, { role: "user", text: question }]);
    const r = await ask(question, history);
    setBusy(false);
    if (r.error || !r.text) {
      setError(r.error ?? "Gemini sent back no text.");
      if (question) setTurns(history);
      return;
    }
    setModel(r.model ?? null);
    setTurns(question ? [...history, { role: "user", text: question }, { role: "model", text: r.text }] : [{ role: "model", text: r.text }]);
  }

  useEffect(() => {
    if (ready && !asked.current) {
      asked.current = true;
      void run(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, busy]);

  return (
    <AnimatePresence>
      {ready && (
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.5, ease: EASE_ENTER }}
          className="raised flex max-h-[40%] min-h-0 shrink-0 flex-col overflow-hidden rounded-[14px] border border-line"
          aria-label="Gemini brief"
        >
          <header className="flex h-10 shrink-0 items-center justify-between gap-3 px-4">
            <h2 className="label flex items-center gap-2">
              <Spark />
              Hand-off brief by Gemini
            </h2>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(null)}
              className="text-[12px] text-muted underline underline-offset-4 transition-colors hover:text-text disabled:opacity-40"
            >
              {turns.length ? "Write again" : "Write it"}
            </button>
          </header>
          <div ref={scroller} className="scroll-thin flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 pb-2" aria-live="polite">
            {turns.map((t, i) =>
              t.role === "model" ? (
                <p key={i} className="whitespace-pre-wrap border-l-2 border-[#8ab4f8] pl-3 text-[13.5px] leading-[1.5] text-text">
                  {t.text}
                </p>
              ) : (
                <p key={i} className="whitespace-pre-wrap text-[13px] text-muted">
                  {t.text}
                </p>
              ),
            )}
            {busy && <p className="shimmer text-[13px]">Gemini is reading the scan…</p>}
            {error && <p className="text-[13px] text-uncertain">{error}</p>}
            {model && !busy && <p className="text-[11px] text-muted">{model} · check against the readings before sending</p>}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const q = text.trim();
              if (!q || busy) return;
              setText("");
              void run(q);
            }}
            className="mx-3 mb-3 flex shrink-0 items-center gap-1.5 rounded-[12px] border border-[rgba(255,255,255,0.08)] bg-[rgba(0,0,0,0.22)] p-1 pl-3 focus-within:border-[rgba(255,255,255,0.18)]"
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Ask Gemini about this scan"
              aria-label="Ask Gemini about this scan"
              className="h-8 min-w-0 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-muted"
            />
            <button
              type="submit"
              aria-label="Ask Gemini"
              disabled={!text.trim() || busy}
              className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-text text-bg transition-[opacity,transform] duration-150 active:scale-[0.94] disabled:opacity-25"
            >
              <IconArrowUp size={14} strokeWidth={1.8} />
            </button>
          </form>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
