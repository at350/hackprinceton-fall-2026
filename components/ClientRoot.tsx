"use client";

import dynamic from "next/dynamic";

// The store, canvases and timers are browser-only.
const Dashboard = dynamic(() => import("./Dashboard"), { ssr: false });

export function ClientRoot() {
  return <Dashboard />;
}
