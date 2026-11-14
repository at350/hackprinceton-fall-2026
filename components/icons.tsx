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

/** Hugeicons usb-connected-01 */
export const IconUsb = (p: P) => <Svg {...p} body={"<g fill=\"none\" stroke=\"currentColor\"><path stroke-linecap=\"round\" d=\"M10.984 16.5H9.016a3.08 3.08 0 0 1-2.547-1.338l-.601-.885a9.9 9.9 0 0 1-1.68-4.785l-.184-2.379C3.937 6.243 4.64 5.5 5.53 5.5h8.94c.89 0 1.593.743 1.525 1.613L15.928 8\"/><path d=\"M13.5 6v-.5c0-1.404 0-2.107-.337-2.611a2 2 0 0 0-.552-.552C12.107 2 11.404 2 10 2s-2.107 0-2.611.337a2 2 0 0 0-.552.552C6.5 3.393 6.5 4.096 6.5 5.5V6\"/><path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M10 17v5M9 8.5h2m1 5s1 0 2 2c0 0 3.177-5 6-6\"/></g>"} />;

/** Hugeicons layers-01 */
export const IconLayers = (p: P) => <Svg {...p} body={"<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"m8.643 3.146l-1.705.788C4.313 5.147 3 5.754 3 6.75s1.313 1.603 3.938 2.816l1.705.788c1.652.764 2.478 1.146 3.357 1.146s1.705-.382 3.357-1.146l1.705-.788C19.687 8.353 21 7.746 21 6.75s-1.313-1.603-3.938-2.816l-1.705-.788C13.705 2.382 12.879 2 12 2s-1.705.382-3.357 1.146\"/><path d=\"M20.788 11.097c.141.199.212.406.212.634c0 .982-1.313 1.58-3.938 2.776l-1.705.777c-1.652.753-2.478 1.13-3.357 1.13s-1.705-.377-3.357-1.13l-1.705-.777C4.313 13.311 3 12.713 3 11.731c0-.228.07-.435.212-.634\"/><path d=\"M20.377 16.266c.415.331.623.661.623 1.052c0 .981-1.313 1.58-3.938 2.776l-1.705.777C13.705 21.624 12.879 22 12 22s-1.705-.376-3.357-1.13l-1.705-.776C4.313 18.898 3 18.299 3 17.318c0-.391.208-.72.623-1.052\"/></g>"} />;

/** Hugeicons robot-01 */
export const IconRobot = (p: P) => <Svg {...p} body={"<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M12 4V2m8 20a8 8 0 1 0-16 0M9.375 8.25H9.25m.25 0a.25.25 0 1 1-.5 0a.25.25 0 0 1 .5 0m5.375 0h-.125m.25 0a.25.25 0 1 1-.5 0a.25.25 0 0 1 .5 0\"/><path d=\"M15.154 4H8.846c-1.255 0-1.883 0-2.372.22A2.5 2.5 0 0 0 5.22 5.474C5 5.964 5 6.591 5 7.846c0 2.008 0 3.013.352 3.796a4 4 0 0 0 2.006 2.006C8.141 14 9.146 14 11.154 14h1.692c2.008 0 3.013 0 3.796-.352a4 4 0 0 0 2.006-2.006C19 10.859 19 9.854 19 7.846c0-1.255 0-1.883-.22-2.372a2.5 2.5 0 0 0-1.254-1.254C17.036 4 16.409 4 15.154 4\"/></g>"} />;

/** Hugeicons ranking */
export const IconRanking = (p: P) => <Svg {...p} body={"<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M3.5 18c0-1.414 0-2.121.44-2.56C4.378 15 5.085 15 6.5 15H7c.943 0 1.414 0 1.707.293S9 16.057 9 17v5H3.5zM15 19c0-.943 0-1.414.293-1.707S16.057 17 17 17h.5c1.414 0 2.121 0 2.56.44c.44.439.44 1.146.44 2.56v2H15zM2 22h20M9 16c0-1.414 0-2.121.44-2.56C9.878 13 10.585 13 12 13s2.121 0 2.56.44c.44.439.44 1.146.44 2.56v6H9zm3.691-13.422l.704 1.42a.87.87 0 0 0 .568.423l1.276.213c.816.137 1.008.734.42 1.323l-.992 1a.88.88 0 0 0-.208.73l.284 1.238c.224.98-.292 1.359-1.152.847l-1.196-.714a.86.86 0 0 0-.792 0l-1.196.714c-.856.512-1.376.129-1.152-.847l.284-1.238a.88.88 0 0 0-.208-.73l-.991-1c-.584-.589-.396-1.186.42-1.323l1.275-.213a.87.87 0 0 0 .564-.424l.704-1.42c.384-.77 1.008-.77 1.388 0\"/>"} />;

/** Hugeicons user-check-01 */
export const IconUserCheck = (p: P) => <Svg {...p} body={"<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M3 21c.284-3.694 3.3-6.78 7-6.962q.469-.023 1-.038l.995.066a7.5 7.5 0 0 1 3.005.849\"/><circle cx=\"11\" cy=\"7\" r=\"4\"/><path d=\"M14 19.333s.875 0 1.75 1.667c0 0 2.78-4.167 5.25-5\"/></g>"} />;

/** Hugeicons sent */
export const IconSent = (p: P) => <Svg {...p} body={"<g fill=\"none\" stroke=\"currentColor\"><path d=\"M21.048 3.053C18.87.707 2.486 6.453 2.5 8.55c.015 2.379 6.398 3.11 8.167 3.607c1.064.299 1.349.604 1.594 1.72c1.111 5.052 1.67 7.566 2.94 7.622c2.027.09 7.972-16.158 5.847-18.447Z\"/><path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M11.5 12.5L15 9\"/></g>"} />;

/** Hugeicons ai-chip */
export const IconAiChip = (p: P) => <Svg {...p} body={"<g fill=\"none\" stroke=\"currentColor\"><path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M18.828 18.828C17.657 20 15.771 20 12 20s-5.657 0-6.828-1.172S4 15.771 4 12s0-5.657 1.172-6.828S8.229 4 12 4s5.657 0 6.828 1.172S20 8.229 20 12s0 5.657-1.172 6.828M8 2v2m8-2v2m-4-2v2M8 20v2m4-2v2m4-2v2m6-6h-2M4 8H2m2 8H2m2-4H2m20-4h-2m2 4h-2\"/><path d=\"M11.48 7.862a.554.554 0 0 1 1.04 0l.8 2.163c.112.303.352.543.655.655l2.163.8a.554.554 0 0 1 0 1.04l-2.163.8a1.1 1.1 0 0 0-.655.655l-.8 2.163a.554.554 0 0 1-1.04 0l-.8-2.163a1.1 1.1 0 0 0-.655-.655l-2.163-.8a.554.554 0 0 1 0-1.04l2.163-.8a1.11 1.11 0 0 0 .655-.655z\"/></g>"} />;

/** Hugeicons database-01 */
export const IconDatabase = (p: P) => <Svg {...p} body={"<g fill=\"none\" stroke=\"currentColor\"><path d=\"M3 12c0-4.243 0-6.364 1.318-7.682S7.758 3 12 3s6.364 0 7.682 1.318S21 7.758 21 12s0 6.364-1.318 7.682S16.242 21 12 21s-6.364 0-7.682-1.318S3 16.242 3 12Z\"/><path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M3 12h18M11 7.5h6m-9.875 0H7m.25 0a.25.25 0 1 1-.5 0a.25.25 0 0 1 .5 0m3.75 9h6m-9.875 0H7m.25 0a.25.25 0 1 1-.5 0a.25.25 0 0 1 .5 0\"/></g>"} />;

/** Hugeicons atom-01 */
export const IconAtom = (p: P) => <Svg {...p} body={"<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M7.778 20.5A9.46 9.46 0 0 1 2.5 13.042M16.222 20.5a9.46 9.46 0 0 0 5.278-7.458M5.878 4.638a9.536 9.536 0 0 1 12.033 0M12.125 21.25H12M3.125 8.5H3m18.125 0H21m-8.75 12.75a.25.25 0 1 1-.5 0a.25.25 0 0 1 .5 0m-9-12.75a.25.25 0 1 1-.5 0a.25.25 0 0 1 .5 0m18 0a.25.25 0 1 1-.5 0a.25.25 0 0 1 .5 0\"/></g>"} />;

/** Hugeicons chart-line-data-01 */
export const IconChart = (p: P) => <Svg {...p} body={"<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\"><path d=\"M21 21H10c-3.3 0-4.95 0-5.975-1.025S3 17.3 3 14V3\"/><path stroke-linejoin=\"round\" d=\"M5 20c.44-3.156 2.676-11.236 5.428-11.236c1.902 0 2.395 3.871 4.258 3.871C17.893 12.635 17.428 4 21 4\"/></g>"} />;

/** Hugeicons full-screen */
export const IconFullScreen = (p: P) => <Svg {...p} body={"<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M15.5 21c1.396 0 2.093 0 2.661-.172a4 4 0 0 0 2.667-2.667C21 17.593 21 16.896 21 15.5m0-7c0-1.396 0-2.093-.172-2.661a4 4 0 0 0-2.667-2.667C17.593 3 16.896 3 15.5 3m-7 18c-1.396 0-2.093 0-2.661-.172a4 4 0 0 1-2.667-2.667C3 17.593 3 16.896 3 15.5m0-7c0-1.396 0-2.093.172-2.661A4 4 0 0 1 5.84 3.172C6.407 3 7.104 3 8.5 3\"/>"} />;

/** Hugeicons search-add */
export const IconZoomIn = (p: P) => <Svg {...p} body={"<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"m17 17l4 4m-2-10a8 8 0 1 0-16 0a8 8 0 0 0 16 0M7.5 11h7M11 7.5v7\"/>"} />;

/** Hugeicons search-minus */
export const IconZoomOut = (p: P) => <Svg {...p} body={"<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"m17 17l4 4m-2-10a8 8 0 1 0-16 0a8 8 0 0 0 16 0M7.5 11h7\"/>"} />;

/** Hugeicons workflow-square-01 */
export const IconWorkflow = (p: P) => <Svg {...p} body={"<g fill=\"none\" stroke=\"currentColor\"><path d=\"M6 5.5c0-.935 0-1.402.201-1.75a1.5 1.5 0 0 1 .549-.549C7.098 3 7.565 3 8.5 3h3c.935 0 1.402 0 1.75.201a1.5 1.5 0 0 1 .549.549C14 4.098 14 4.565 14 5.5s0 1.402-.201 1.75a1.5 1.5 0 0 1-.549.549C12.902 8 12.435 8 11.5 8h-3c-.935 0-1.402 0-1.75-.201a1.5 1.5 0 0 1-.549-.549C6 6.902 6 6.435 6 5.5Zm0 10c0-.935 0-1.402.201-1.75a1.5 1.5 0 0 1 .549-.549C7.098 13 7.565 13 8.5 13h3c.935 0 1.402 0 1.75.201a1.5 1.5 0 0 1 .549.549c.201.348.201.815.201 1.75s0 1.402-.201 1.75a1.5 1.5 0 0 1-.549.549c-.348.201-.815.201-1.75.201h-3c-.935 0-1.402 0-1.75-.201a1.5 1.5 0 0 1-.549-.549C6 16.902 6 16.435 6 15.5Zm14.84 1.64c.773-.773 1.16-1.16 1.16-1.64s-.387-.867-1.16-1.64l-.2-.2c-.773-.773-1.16-1.16-1.64-1.16s-.867.387-1.64 1.16l-.2.2c-.773.773-1.16 1.16-1.16 1.64s.387.867 1.16 1.64l.2.2c.773.773 1.16 1.16 1.64 1.16s.867-.387 1.64-1.16z\"/><path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M6.006 5.5H2.008m0 0V2m0 3.5V12c0 1.104-.151 2.468.888 3.163c.504.337 1.206.337 2.61.337m8.496 0h2m2.998-3v-3c0-1.886 0-2.828-.585-3.414c-.586-.586-1.528-.586-3.413-.586h-1M22 22c-.932 0-1.398 0-1.765-.13c-.49-.175-.88-.508-1.083-.928C19 20.627 19 20.227 19 19.429V19\"/></g>"} />;

/** Hugeicons dashboard-square-01 */
export const IconDashboard = (p: P) => <Svg {...p} body={"<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"square\" stroke-linejoin=\"round\" d=\"M13.69 19.457c-.19-.46-.19-1.042-.19-2.207s0-1.747.19-2.207a2.5 2.5 0 0 1 1.353-1.353c.46-.19 1.042-.19 2.207-.19s1.747 0 2.207.19a2.5 2.5 0 0 1 1.353 1.353c.19.46.19 1.042.19 2.207s0 1.747-.19 2.207a2.5 2.5 0 0 1-1.353 1.353c-.46.19-1.042.19-2.207.19s-1.747 0-2.207-.19a2.5 2.5 0 0 1-1.353-1.353Zm0-10.5c-.19-.46-.19-1.042-.19-2.207s0-1.747.19-2.207a2.5 2.5 0 0 1 1.353-1.353C15.503 3 16.085 3 17.25 3s1.747 0 2.207.19a2.5 2.5 0 0 1 1.353 1.353c.19.46.19 1.042.19 2.207s0 1.747-.19 2.207a2.5 2.5 0 0 1-1.353 1.353c-.46.19-1.042.19-2.207.19s-1.747 0-2.207-.19a2.5 2.5 0 0 1-1.353-1.353Zm-10.5 10.5C3 18.997 3 18.415 3 17.25s0-1.747.19-2.207a2.5 2.5 0 0 1 1.353-1.353c.46-.19 1.042-.19 2.207-.19s1.747 0 2.207.19a2.5 2.5 0 0 1 1.353 1.353c.19.46.19 1.042.19 2.207s0 1.747-.19 2.207a2.5 2.5 0 0 1-1.353 1.353c-.46.19-1.042.19-2.207.19s-1.747 0-2.207-.19a2.5 2.5 0 0 1-1.353-1.353Zm0-10.5C3 8.497 3 7.915 3 6.75s0-1.747.19-2.207A2.5 2.5 0 0 1 4.543 3.19C5.003 3 5.585 3 6.75 3s1.747 0 2.207.19a2.5 2.5 0 0 1 1.353 1.353c.19.46.19 1.042.19 2.207s0 1.747-.19 2.207a2.5 2.5 0 0 1-1.353 1.353c-.46.19-1.042.19-2.207.19s-1.747 0-2.207-.19A2.5 2.5 0 0 1 3.19 8.957Z\"/>"} />;

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
