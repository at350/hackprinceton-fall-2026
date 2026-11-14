"use client";

import { useEffect } from "react";
import { demo } from "@/lib/demo";
import { AgentPanel } from "./AgentPanel";
import { Header } from "./Header";
import { LeftPanel } from "./LeftPanel";
import { LiveData } from "./LiveData";

export default function Dashboard() {
  useEffect(() => {
    demo.start();
    return () => demo.stop();
  }, []);

  return (
    <main className="h-full p-3">
      <div className="frame flex h-full flex-col gap-3 px-4 pt-3 pb-4">
        <Header />
        <div className="relative z-10 flex min-h-0 flex-1 gap-4">
          <LeftPanel />
          <aside className="flex w-[clamp(320px,29vw,420px)] shrink-0 flex-col gap-4">
            <LiveData />
            <AgentPanel />
          </aside>
        </div>
      </div>
    </main>
  );
}
