"use client";

import dynamic from "next/dynamic";
import { Component, useCallback, useState, type ReactNode } from "react";
import { BrainCanvas, BrainOverlay, BrainView, type BrainViewProps } from "./BrainView";

const Brain3DView = dynamic(() => import("./Brain3DView"), { ssr: false });

class CortexBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function Cortex({ scan, spots, current }: BrainViewProps) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const onReady = useCallback(() => setReady(true), []);
  const onFailure = useCallback(() => { setReady(false); setFailed(true); }, []);
  return (
    <div className="relative" style={{ width: "min(100cqw, 100cqh)", height: "min(100cqw, 100cqh)" }} data-brain-view={failed ? "fallback" : ready ? "3d" : "loading"}>
      {failed && <BrainCanvas scan={scan} />}
      {!ready && <BrainOverlay spots={spots} current={current} />}
      {!failed && <Brain3DView scan={scan} spots={spots} current={current} onReady={onReady} onFailure={onFailure} />}
    </div>
  );
}

export function InteractiveBrainView(props: BrainViewProps) {
  // A restart discards both the old coverage texture and an in-flight reveal.
  return <CortexBoundary key={props.run} fallback={<BrainView {...props} />}><Cortex {...props} /></CortexBoundary>;
}
