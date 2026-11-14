import { prepareAnatomy, generateAnatomicalFolds, foldAttributes, type Anatomy } from "./brain-anatomy";
import { surfaceNormals } from "./brain-geometry";
import type { CortexModel } from "./brain-geometry";

let anatomy: { left: Anatomy; right: Anatomy };
self.onmessage = (event: MessageEvent<{ seed: number; count: number; model?: CortexModel; request: number }>) => {
  const { seed, count, model, request } = event.data;
  try {
    const start = performance.now();
    if (model) anatomy = { left: prepareAnatomy(model.left, "left", 0), right: prepareAnatomy(model.right, "right", 0) };
    const envelopeMs = performance.now() - start;
    const parts = (Object.keys(anatomy) as ("left" | "right")[]).map((side) => {
      const a = anatomy[side];
      const cuts = generateAnatomicalFolds(a, side === "left" ? seed : seed ^ 0x9e3779b9, count);
      const shape = foldAttributes(a, cuts, count);
      if (!model) return { side, ...shape };
      return { side, ...shape, positions: a.positions.slice(), normals: surfaceNormals(a.positions, a.faces), faces: a.faces.slice() };
    });
    const generationMs = performance.now() - start - envelopeMs;
    const transfer = parts.flatMap((part) => Object.values(part).filter((v) => ArrayBuffer.isView(v)).map((v) => (v as Float32Array).buffer as ArrayBuffer));
    self.postMessage({ request, seed, count, parts, envelopeMs, generationMs }, { transfer });
  } catch (error) { self.postMessage({ request, error: String(error) }); }
};
