"use client";

import { useEffect } from "react";
import { demo } from "@/lib/demo";
import { useDash } from "@/lib/useDash";
import { AgentPanel } from "./AgentPanel";
import { Header } from "./Header";
import { LeftPanel } from "./LeftPanel";
import { LiveData } from "./LiveData";
import { TracePage } from "./TracePage";

export default function Dashboard() {
  const view = useDash((s) => s.view);

  useEffect(() => {
    // Dev aid for screenshots: ?view=trace&t=90000 opens a view at a story time.
    if (process.env.NODE_ENV !== "production") {
      const q = new URLSearchParams(location.search);
      if (q.get("t")) demo.seek(Number(q.get("t")));
      if (q.get("view") === "trace") demo.setView("trace");
    }
    demo.start();
    return () => demo.stop();
  }, []);

  return (
    <main className="h-full p-3">
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
