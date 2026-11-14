"use client";

import { useEffect, useId, useRef, useState } from "react";
import { DEFAULT_FOLDING, type FoldingParameters } from "@/lib/brain-geometry";
import { DEFAULT_SEED } from "@/lib/brain-anatomy";
import { createBrainScene } from "@/lib/brain-scene";
import { BrainOverlay, type BrainViewProps } from "./BrainView";
import { IconResetView, IconSliders, IconRestart } from "./icons";

export default function Brain3DView({ scan, spots, current, onReady, onFailure }: Omit<BrainViewProps, "run"> & { onReady: () => void; onFailure: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<SVGGElement>(null);
  const scene = useRef<ReturnType<typeof createBrainScene> | null>(null);
  const [ready, setReady] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [open, setOpen] = useState(false);
  const [parameters, setParameters] = useState<FoldingParameters>({ ...DEFAULT_FOLDING });
  const panelId = useId();
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    try {
      scene.current = createBrainScene(canvas.current!, overlay.current!, () => {
        if (active) { setReady(true); onReady(); }
      }, () => { if (active) onFailure(); }, (value) => { if (active) setGenerating(value); });
    } catch { onFailure(); }
    return () => { active = false; scene.current?.dispose(); scene.current = null; };
  }, [onReady, onFailure]);
  useEffect(() => { scene.current?.setParameters(parameters); }, [parameters]);
  useEffect(() => { scene.current?.setScan(scan, spots.filter((spot) => spot.state === "done").map((spot) => spot.index)); }, [scan, spots]);

  return (
    <div className="brain-arrival absolute inset-0" style={{ opacity: ready ? 1 : 0, pointerEvents: ready ? "auto" : "none" }}>
      <canvas ref={canvas} className="absolute inset-0 size-full cursor-grab rounded-[14px] outline-offset-[-2px]" style={{ touchAction: "none" }} tabIndex={0} role="img" aria-label="Interactive 3D brain. Drag or use arrow keys to orbit; release to return to the view from above. Home resets the view." />
      <BrainOverlay spots={spots} current={current} groupRef={overlay} />
      <div className="brain-tools absolute bottom-0 flex items-center gap-1.5">
        <button type="button" className="brain-tool glass" onClick={() => scene.current?.resetView()} aria-label="Reset brain view" title="Reset view"><IconResetView size={18} /></button>
        <button ref={toggle} type="button" className="brain-tool glass" aria-label="Adjust cortical folding" aria-expanded={open} aria-controls={panelId} title="Cortical folding" onClick={() => setOpen(!open)}><IconSliders size={18} /></button>
      </div>
      {open && (
        <section id={panelId} className="brain-controls glass" aria-label="Cortical folding" onKeyDown={(event) => { if (event.key === "Escape") { setOpen(false); toggle.current?.focus(); } }}>
          <div className="mb-4 flex items-center justify-between gap-5">
            <h3 className="text-[13px] font-medium text-text">Cortical folding</h3>
            <button type="button" className="text-[12px] text-muted hover:text-text" onClick={() => { setParameters({ ...DEFAULT_FOLDING }); scene.current?.regenerate(DEFAULT_SEED); }}>Reset</button>
          </div>
          {([
            { key: "folding", label: "Fold count", max: 100, left: "Few folds", right: "Many folds" },
            { key: "depth", label: "Fold depth", max: 200, left: "Surface lines", right: "Deep" },
          ] as const).map(({ key, label, max, left, right }) => (
            <label key={key} className="block text-[13px] text-muted">
              <span className="flex items-center justify-between"><span>{label}</span><output className="tabular-nums text-text">{Math.round(parameters[key] * 100)}%</output></span>
              <input type="range" className="brain-slider" min={0} max={max} step={1} value={Math.round(parameters[key] * 100)} aria-label={label} aria-valuetext={`${Math.round(parameters[key] * 100)} percent`} onChange={(event) => setParameters((previous) => ({ ...previous, [key]: Number(event.target.value) / 100 }))} style={{ backgroundImage: `linear-gradient(to right, #acb5c0 ${parameters[key] * 10000 / max}%, rgba(255,255,255,0.12) ${parameters[key] * 10000 / max}%)` }} />
              <span className="flex justify-between text-[11px] text-muted"><span>{left}</span><span>{right}</span></span>
            </label>
          ))}
          <div className="mt-4 flex items-center justify-between gap-2 border-t border-white/[0.07] pt-3">
            <span role="status" className="text-[11px] text-muted">{generating ? "Forming folds…" : "New pattern"}</span>
            <button type="button" className="brain-tool disabled:opacity-40" aria-label="Regenerate fold pattern" title="Regenerate" disabled={generating} onClick={() => scene.current?.regenerate(crypto.getRandomValues(new Uint32Array(1))[0])}><IconRestart size={18} /></button>
          </div>
        </section>
      )}
    </div>
  );
}
