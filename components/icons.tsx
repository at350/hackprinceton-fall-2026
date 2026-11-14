import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

/**
 * Hugeicons (stroke rounded, 24px grid, MIT) embedded as SVG so there is no
 * extra dependency. Every icon uses the set's own 1.5 stroke for consistency.
 */
function Svg({ size = 16, body, ...rest }: P & { body: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: body }}
      {...rest}
      strokeWidth={1.5}
    />
  );
}

/** Hugeicons alert-02 */
export const IconAlert = (p: P) => <Svg {...p} body={"<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M13.925 21h-3.85c-4.63 0-6.945 0-7.799-1.506c-.853-1.506.331-3.503 2.7-7.495L6.9 8.753C9.176 4.918 10.313 3 12 3s2.824 1.918 5.1 5.753L19.023 12c2.369 3.992 3.553 5.989 2.7 7.495C20.87 21 18.555 21 13.924 21M12 9v4\"/><path d=\"M12.125 16.75H12m.25 0a.25.25 0 1 1-.5 0a.25.25 0 0 1 .5 0\"/></g>"} />;

/** Hugeicons help-circle */
export const IconQuestion = (p: P) => <Svg {...p} body={"<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M9.5 9.5a2.5 2.5 0 1 1 3.912 2.064C12.728 12.032 12 12.672 12 13.5m.125 3.25H12m.25 0a.25.25 0 1 1-.5 0a.25.25 0 0 1 .5 0\"/></g>"} />;

/** Hugeicons security-check */
export const IconShieldCheck = (p: P) => <Svg {...p} body={"<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M18.709 3.495C16.817 2.554 14.5 2 12 2s-4.816.554-6.709 1.495c-.928.462-1.392.693-1.841 1.419S3 6.342 3 7.748v3.49c0 5.683 4.542 8.842 7.173 10.196c.734.377 1.1.566 1.827.566s1.093-.189 1.827-.566C16.457 20.08 21 16.92 21 11.237V7.748c0-1.406 0-2.108-.45-2.834s-.913-.957-1.841-1.419\"/><path d=\"M9 11.5s1.408.252 2 2c0 0 1.5-3 4-4\"/></g>"} />;

/** Hugeicons tick-02 */
export const IconCheck = (p: P) => <Svg {...p} body={"<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"m5 14l3.5 3.5L19 6.5\"/>"} />;

/** Hugeicons cancel-01 */
export const IconX = (p: P) => <Svg {...p} body={"<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M18 6L6 18m12 0L6 6\"/>"} />;

/** Hugeicons clock-01 */
export const IconClock = (p: P) => <Svg {...p} body={"<g fill=\"none\" stroke=\"currentColor\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M12 8v4l2 2\"/></g>"} />;

/** Hugeicons information-circle */
export const IconInfo = (p: P) => <Svg {...p} body={"<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M12 16v-4m.125-3.75H12m.25 0a.25.25 0 1 0-.5 0a.25.25 0 0 0 .5 0\"/></g>"} />;

/** Hugeicons arrow-right-02 */
export const IconArrowRight = (p: P) => <Svg {...p} body={"<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M18.5 12H5m8 6s6-4.419 6-6s-6-6-6-6\"/>"} />;

/** Hugeicons arrow-up-02 */
export const IconArrowUp = (p: P) => <Svg {...p} body={"<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M12 5.5V19m6-8s-4.419-6-6-6s-6 6-6 6\"/>"} />;

/** Hugeicons play */
export const IconPlay = (p: P) => <Svg {...p} body={"<path fill=\"none\" stroke=\"currentColor\" stroke-linejoin=\"round\" d=\"M18.89 12.846c-.353 1.343-2.023 2.292-5.364 4.19c-3.23 1.835-4.845 2.752-6.146 2.384a3.25 3.25 0 0 1-1.424-.841C5 17.614 5 15.743 5 12s0-5.614.956-6.579a3.25 3.25 0 0 1 1.424-.84c1.301-.37 2.916.548 6.146 2.383c3.34 1.898 5.011 2.847 5.365 4.19a3.3 3.3 0 0 1 0 1.692Z\"/>"} />;

/** Hugeicons pause */
export const IconPause = (p: P) => <Svg {...p} body={"<path fill=\"none\" stroke=\"currentColor\" d=\"M4 7c0-1.414 0-2.121.44-2.56C4.878 4 5.585 4 7 4s2.121 0 2.56.44C10 4.878 10 5.585 10 7v10c0 1.414 0 2.121-.44 2.56C9.122 20 8.415 20 7 20s-2.121 0-2.56-.44C4 19.122 4 18.415 4 17zm10 0c0-1.414 0-2.121.44-2.56C14.878 4 15.585 4 17 4s2.121 0 2.56.44C20 4.878 20 5.585 20 7v10c0 1.414 0 2.121-.44 2.56c-.439.44-1.146.44-2.56.44s-2.121 0-2.56-.44C14 19.122 14 18.415 14 17z\"/>"} />;

/** Hugeicons reload */
export const IconRestart = (p: P) => <Svg {...p} body={"<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M16.5 8H18c1.414 0 2.121 0 2.56-.44C21 7.121 21 6.414 21 5V3.5\"/><path d=\"M3 12a9 9 0 0 1 9-9c3.571 0 6.095 1.73 8 4.083M21 12a9 9 0 0 1-9 9c-3.571 0-6.095-1.73-8-4.084\"/><path d=\"M7.5 16H6c-1.414 0-2.121 0-2.56.44C3 16.877 3 17.584 3 19v1.5\"/></g>"} />;

/** Hugeicons unlink-02 */
export const IconPlug = (p: P) => <Svg {...p} body={"<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\"><path d=\"m16.846 14.61l2.61-2.61A5.272 5.272 0 1 0 12 4.544l-2.61 2.61m5.22 9.692L12 19.456A5.272 5.272 0 1 1 4.544 12l2.61-2.61\"/><path stroke-linejoin=\"round\" d=\"M22 17h-2.079M17 22v-2.079M2 7h2.079M7 2v2.079\"/></g>"} />;

/** Hugeicons link-01 */
export const IconLink = (p: P) => <Svg {...p} body={"<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\"><path d=\"m9.143 10.691l.207-.207a5.067 5.067 0 1 1 7.166 7.166l-2.866 2.866a5.067 5.067 0 1 1-7.166-7.166l.464-.464\"/><path d=\"m17.052 11.114l.464-.464a5.067 5.067 0 1 0-7.166-7.166L7.484 6.35a5.067 5.067 0 1 0 7.166 7.166l.207-.207\"/></g>"} />;

/** Hugeicons command-line */
export const IconTool = (p: P) => <Svg {...p} body={"<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M14 4h-4C6.229 4 4.343 4 3.172 5.172S2 8.229 2 12s0 5.657 1.172 6.828S6.229 20 10 20h4c3.771 0 5.657 0 6.828-1.172S22 15.771 22 12s0-5.657-1.172-6.828S17.771 4 14 4\"/><path d=\"m7 9l1.84 1.586c.773.666 1.16 1 1.16 1.414s-.387.748-1.16 1.414L7 15m6 1h4\"/></g>"} />;

/** Hugeicons target-02 */
export const IconTarget = (p: P) => <Svg {...p} body={"<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\"><path d=\"M17 12a5 5 0 1 1-5-5\"/><path d=\"M14 2.2q-.97-.198-2-.2C6.477 2 2 6.477 2 12s4.477 10 10 10s10-4.477 10-10q-.002-1.03-.2-2\"/><path stroke-linejoin=\"round\" d=\"m12.03 11.963l4.553-4.553m3.157-3.065l-.553-1.988a.48.48 0 0 0-.761-.24c-1.436 1.173-3 2.754-1.723 5.247c2.574 1.2 4.044-.418 5.17-1.779a.486.486 0 0 0-.248-.775z\"/></g>"} />;

/** Hugeicons hand-pointing-right-04 */
export const IconHand = (p: P) => <Svg {...p} body={"<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M14.531 7.752h5.464a1.503 1.503 0 1 1 0 3.004h-6.51m3.004 0l-.027 1.054a2 2 0 0 1-.978 1.668m-.953-5.726H9.968m4.563 0l-2.76-2.594c-1.867-1.572-3.229-.746-3.985-.166L5.348 6.607C3.281 7.832 2.5 9.25 2.5 10.442v4.88c0 2.267 2.382 4.38 4.566 4.38l5.2.048a2.003 2.003 0 0 0 2.004-1.733l.19-1.54m-1.005-2.718h1.004c.375 0 .725-.103 1.025-.281m0 0l-.054 1.335a2 2 0 0 1-2.003 1.95h-1.004\"/>"} />;

/** Hugeicons arrow-down-01 */
export const IconChevronDown = (p: P) => <Svg {...p} body={"<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M18 9s-4.419 6-6 6s-6-6-6-6\"/>"} />;

/** Signal bars: n of 3 filled. */
export function IconBars({ level, size = 16 }: { level: 1 | 2 | 3; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={2.5 + i * 4}
          y={11 - i * 3.5}
          width={2.6}
          height={2.5 + i * 3.5}
          rx={0.6}
          fill="currentColor"
          opacity={i < level ? 1 : 0.25}
        />
      ))}
    </svg>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="spin" aria-hidden>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity=".2" strokeWidth="1.6" />
      <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Determinate ring: arc fills clockwise from 12 o'clock. */
export function Ring({ progress, size = 13 }: { progress: number; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="-rotate-90" aria-hidden>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity=".22" strokeWidth="1.8" />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        pathLength={1}
        strokeDasharray="1 1"
        strokeDashoffset={1 - Math.max(0.04, progress)}
      />
    </svg>
  );
}
