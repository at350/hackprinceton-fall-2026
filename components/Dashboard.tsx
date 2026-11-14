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
    <>
      <div className="backdrop" />
      <main className="relative z-10 mx-auto flex h-full max-w-[1600px] flex-col gap-3 px-4 pb-4">
        <Header />
        <div className="flex min-h-0 flex-1 gap-4">
          <LeftPanel />
          <aside className="flex w-[420px] shrink-0 flex-col gap-4">
            <LiveData />
            <AgentPanel />
          </aside>
        </div>
      </main>
    </>
  );
}
