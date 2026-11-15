"use client";

import { useEffect } from "react";
import { live } from "@/lib/live";
import { useDash } from "@/lib/useDash";
import { AgentPanel } from "./AgentPanel";
import { Header } from "./Header";
import { LeftPanel } from "./LeftPanel";
import LiveBridge from "./LiveBridge";
import { LiveData } from "./LiveData";
import { TracePage } from "./TracePage";

export default function Dashboard() {
  const view = useDash((s) => s.view);
  const run = useDash((s) => s.run);

  useEffect(() => {
    // Dev aid for screenshots: ?view=trace opens the agent trace.
    if (process.env.NODE_ENV !== "production" && new URLSearchParams(location.search).get("view") === "trace") live.setView("trace");
    live.start();
    return () => live.stop();
  }, []);

  return (
    <main className="h-full p-3">
      {/* One stream per run: a new key is a new thread. */}
      <LiveBridge key={run} run={run} />
      <div className="frame flex h-full flex-col gap-3 px-4 pt-3 pb-4">
        <Header />
        {view === "trace" ? (
          <TracePage />
        ) : (
          <div className="relative z-10 flex min-h-0 flex-1 gap-4">
            <LeftPanel />
            <aside className="flex w-[clamp(320px,29vw,420px)] shrink-0 flex-col gap-4">
              <LiveData />
              <AgentPanel />
            </aside>
          </div>
        )}
      </div>
    </main>
  );
}
