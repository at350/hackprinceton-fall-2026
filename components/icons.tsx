import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

/**
 * Phosphor icons, light weight (MIT), embedded as SVG so there is no extra
 * dependency. Phosphor draws filled outlines on a 256px grid, so the weight is
 * baked into the paths and colour comes from currentColor.
 */
function Svg({ size = 16, body, ...rest }: P & { body: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="currentColor"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: body }}
      {...rest}
    />
  );
}

/** Phosphor warning (light) */
export const IconAlert = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M235.07 189.09L147.61 37.22a22.75 22.75 0 0 0-39.22 0L20.93 189.09a21.53 21.53 0 0 0 0 21.72A22.35 22.35 0 0 0 40.55 222h174.9a22.35 22.35 0 0 0 19.6-11.19a21.53 21.53 0 0 0 .02-21.72m-10.41 15.71a10.46 10.46 0 0 1-9.21 5.2H40.55a10.46 10.46 0 0 1-9.21-5.2a9.51 9.51 0 0 1 0-9.72l87.45-151.87a10.75 10.75 0 0 1 18.42 0l87.46 151.87a9.51 9.51 0 0 1-.01 9.72M122 144v-40a6 6 0 0 1 12 0v40a6 6 0 0 1-12 0m16 36a10 10 0 1 1-10-10a10 10 0 0 1 10 10\"/>"} />;

/** Phosphor question (light) */
export const IconQuestion = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M138 180a10 10 0 1 1-10-10a10 10 0 0 1 10 10M128 74c-21 0-38 15.25-38 34v4a6 6 0 0 0 12 0v-4c0-12.13 11.66-22 26-22s26 9.87 26 22s-11.66 22-26 22a6 6 0 0 0-6 6v8a6 6 0 0 0 12 0v-2.42c18.11-2.58 32-16.66 32-33.58c0-18.75-17-34-38-34m102 54A102 102 0 1 1 128 26a102.12 102.12 0 0 1 102 102m-12 0a90 90 0 1 0-90 90a90.1 90.1 0 0 0 90-90\"/>"} />;

/** Phosphor shield-check (light) */
export const IconShieldCheck = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M208 42H48a14 14 0 0 0-14 14v56c0 51.94 25.12 83.4 46.2 100.64c22.73 18.6 45.27 24.89 46.22 25.15a6 6 0 0 0 3.16 0c.95-.26 23.49-6.55 46.22-25.15C196.88 195.4 222 163.94 222 112V56a14 14 0 0 0-14-14m2 70c0 37.76-13.94 68.39-41.44 91.06A131.2 131.2 0 0 1 128 225.72a131 131 0 0 1-40.56-22.66C59.94 180.39 46 149.76 46 112V56a2 2 0 0 1 2-2h160a2 2 0 0 1 2 2Zm-37.76-12.24a6 6 0 0 1 0 8.48l-56 56a6 6 0 0 1-8.48 0l-24-24a6 6 0 0 1 8.48-8.48L112 151.51l51.76-51.75a6 6 0 0 1 8.48 0\"/>"} />;

/** Phosphor check (light) */
export const IconCheck = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"m228.24 76.24l-128 128a6 6 0 0 1-8.48 0l-56-56a6 6 0 0 1 8.48-8.48L96 191.51L219.76 67.76a6 6 0 0 1 8.48 8.48\"/>"} />;

/** Phosphor x (light) */
export const IconX = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M204.24 195.76a6 6 0 1 1-8.48 8.48L128 136.49l-67.76 67.75a6 6 0 0 1-8.48-8.48L119.51 128L51.76 60.24a6 6 0 0 1 8.48-8.48L128 119.51l67.76-67.75a6 6 0 0 1 8.48 8.48L136.49 128Z\"/>"} />;

/** Phosphor clock (light) */
export const IconClock = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M128 26a102 102 0 1 0 102 102A102.12 102.12 0 0 0 128 26m0 192a90 90 0 1 1 90-90a90.1 90.1 0 0 1-90 90m62-90a6 6 0 0 1-6 6h-56a6 6 0 0 1-6-6V72a6 6 0 0 1 12 0v50h50a6 6 0 0 1 6 6\"/>"} />;

/** Phosphor info (light) */
export const IconInfo = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M142 176a6 6 0 0 1-6 6a14 14 0 0 1-14-14v-40a2 2 0 0 0-2-2a6 6 0 0 1 0-12a14 14 0 0 1 14 14v40a2 2 0 0 0 2 2a6 6 0 0 1 6 6m-18-82a10 10 0 1 0-10-10a10 10 0 0 0 10 10m106 34A102 102 0 1 1 128 26a102.12 102.12 0 0 1 102 102m-12 0a90 90 0 1 0-90 90a90.1 90.1 0 0 0 90-90\"/>"} />;

/** Phosphor arrow-right (light) */
export const IconArrowRight = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"m220.24 132.24l-72 72a6 6 0 0 1-8.48-8.48L201.51 134H40a6 6 0 0 1 0-12h161.51l-61.75-61.76a6 6 0 0 1 8.48-8.48l72 72a6 6 0 0 1 0 8.48\"/>"} />;

/** Phosphor arrow-up (light) */
export const IconArrowUp = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M204.24 116.24a6 6 0 0 1-8.48 0L134 54.49V216a6 6 0 0 1-12 0V54.49l-61.76 61.75a6 6 0 0 1-8.48-8.48l72-72a6 6 0 0 1 8.48 0l72 72a6 6 0 0 1 0 8.48\"/>"} />;

/** Phosphor play (light) */
export const IconPlay = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M231.36 116.19L87.28 28.06a14 14 0 0 0-14.18-.27A13.69 13.69 0 0 0 66 39.87v176.26a13.69 13.69 0 0 0 7.1 12.08a14 14 0 0 0 14.18-.27l144.08-88.13a13.82 13.82 0 0 0 0-23.62m-6.26 13.38L81 217.7a2 2 0 0 1-2.06 0a1.78 1.78 0 0 1-1-1.61V39.87a1.78 1.78 0 0 1 1-1.61A2.06 2.06 0 0 1 80 38a2 2 0 0 1 1 .31l144.1 88.12a1.82 1.82 0 0 1 0 3.14\"/>"} />;

/** Phosphor pause (light) */
export const IconPause = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M200 34h-40a14 14 0 0 0-14 14v160a14 14 0 0 0 14 14h40a14 14 0 0 0 14-14V48a14 14 0 0 0-14-14m2 174a2 2 0 0 1-2 2h-40a2 2 0 0 1-2-2V48a2 2 0 0 1 2-2h40a2 2 0 0 1 2 2ZM96 34H56a14 14 0 0 0-14 14v160a14 14 0 0 0 14 14h40a14 14 0 0 0 14-14V48a14 14 0 0 0-14-14m2 174a2 2 0 0 1-2 2H56a2 2 0 0 1-2-2V48a2 2 0 0 1 2-2h40a2 2 0 0 1 2 2Z\"/>"} />;

/** Phosphor arrow-counter-clockwise (light) */
export const IconRestart = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M222 128a94 94 0 0 1-92.74 94H128a93.43 93.43 0 0 1-64.5-25.65a6 6 0 1 1 8.24-8.72A82 82 0 1 0 70 70l-.19.19L39.44 98H72a6 6 0 0 1 0 12H24a6 6 0 0 1-6-6V56a6 6 0 0 1 12 0v34.34L61.63 61.4A94 94 0 0 1 222 128\"/>"} />;

/** Phosphor plugs (light) */
export const IconPlug = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M148.24 139.76a6 6 0 0 0-8.48 0L120 159.51L96.49 136l19.75-19.76a6 6 0 0 0-8.48-8.48L88 127.51l-19.76-19.75a6 6 0 0 0-8.48 8.48l7.75 7.76l-24.72 24.73a30 30 0 0 0 0 42.42l6.78 6.79l-29.81 29.82a6 6 0 1 0 8.48 8.48l29.82-29.81l6.79 6.78a30 30 0 0 0 42.42 0L132 188.49l7.76 7.75a6 6 0 0 0 8.48-8.48L128.49 168l19.75-19.76a6 6 0 0 0 0-8.48m-49.45 65a18 18 0 0 1-25.46 0l-22.06-22.09a18 18 0 0 1 0-25.46L76 132.49L123.51 180Zm137.45-185a6 6 0 0 0-8.48 0l-29.82 29.81l-6.79-6.78a30 30 0 0 0-42.42 0L124 67.51l-7.76-7.75a6 6 0 0 0-8.48 8.48l80 80a6 6 0 0 0 8.48-8.48l-7.75-7.76l24.72-24.73a30 30 0 0 0 0-42.42l-6.78-6.79l29.81-29.82a6 6 0 0 0 0-8.48m-31.51 79L180 123.51L132.49 76l24.72-24.73a18 18 0 0 1 25.46 0l22.06 22.06a18 18 0 0 1 0 25.46Z\"/>"} />;

/** Phosphor link (light) */
export const IconLink = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M238 88.18a52.42 52.42 0 0 1-15.4 35.66l-34.75 34.75A52.28 52.28 0 0 1 150.62 174h-.05A52.63 52.63 0 0 1 98 119.9a6 6 0 0 1 6-5.84h.17a6 6 0 0 1 5.83 6.16A40.62 40.62 0 0 0 150.58 162a40.4 40.4 0 0 0 28.73-11.9l34.75-34.74a40.63 40.63 0 0 0-57.43-57.46l-11 11a6 6 0 0 1-8.49-8.49l11-11a52.62 52.62 0 0 1 74.43 0A52.83 52.83 0 0 1 238 88.18m-127.62 98.9l-11 11A40.36 40.36 0 0 1 70.6 210a40.63 40.63 0 0 1-28.7-69.36l34.72-34.74A40.63 40.63 0 0 1 146 135.77a6 6 0 0 0 5.83 6.16h.17a6 6 0 0 0 6-5.84a52.63 52.63 0 0 0-89.86-38.67l-34.76 34.74A52.63 52.63 0 0 0 70.56 222a52.26 52.26 0 0 0 37.22-15.42l11-11a6 6 0 1 0-8.49-8.48Z\"/>"} />;

/** Phosphor terminal (light) */
export const IconTool = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"m116 132.48l-72 64a6 6 0 0 1-8-9L103 128L36 68.49a6 6 0 0 1 8-9l72 64a6 6 0 0 1 0 9ZM216 186h-96a6 6 0 0 0 0 12h96a6 6 0 0 0 0-12\"/>"} />;

/** Phosphor target (light) */
export const IconTarget = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M220.06 84a102.06 102.06 0 1 1-24.31-32.27l24-24a6 6 0 0 1 8.48 8.49l-96 96a6 6 0 1 1-8.48-8.49l29.39-29.4a42 42 0 1 0 16.78 31.24a6 6 0 1 1 12-.68a54 54 0 1 1-20.22-39.06l25.54-25.55a89.91 89.91 0 1 0 22 28.93A6 6 0 1 1 220.06 84\"/>"} />;

/** Phosphor hand (light) */
export const IconHand = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M188 50a25.8 25.8 0 0 0-14 4.11V44a26 26 0 0 0-51.41-5.51A26 26 0 0 0 82 60v71l-7.53-12.1a26 26 0 0 0-45.11 25.87C60.76 211 78.51 238 128 238a86.1 86.1 0 0 0 86-86V76a26 26 0 0 0-26-26m14 102a74.09 74.09 0 0 1-74 74c-21 0-34.51-5.05-46.75-17.45C67.81 195 55.54 172 40.1 139.43l-.23-.43a14 14 0 0 1 24.25-14l.1.17l18.68 30A6 6 0 0 0 94 152V60a14 14 0 0 1 28 0v60a6 6 0 0 0 12 0V44a14 14 0 0 1 28 0v76a6 6 0 0 0 12 0V76a14 14 0 0 1 28 0Z\"/>"} />;

/** Phosphor caret-down (light) */
export const IconChevronDown = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"m212.24 100.24l-80 80a6 6 0 0 1-8.48 0l-80-80a6 6 0 0 1 8.48-8.48L128 167.51l75.76-75.75a6 6 0 0 1 8.48 8.48\"/>"} />;

/** Phosphor usb (light) */
export const IconUsb = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"m251.33 123l-48-32a6 6 0 0 0-9.33 5v26H70V72a2 2 0 0 1 2-2h34.6a30 30 0 1 0 0-12H72a14 14 0 0 0-14 14v50H8a6 6 0 0 0 0 12h50v50a14 14 0 0 0 14 14h34v10a14 14 0 0 0 14 14h32a14 14 0 0 0 14-14v-32a14 14 0 0 0-14-14h-32a14 14 0 0 0-14 14v10H72a2 2 0 0 1-2-2v-50h124v26a6 6 0 0 0 9.33 5l48-32a6 6 0 0 0 0-10M136 46a18 18 0 1 1-18 18a18 18 0 0 1 18-18m-18 130a2 2 0 0 1 2-2h32a2 2 0 0 1 2 2v32a2 2 0 0 1-2 2h-32a2 2 0 0 1-2-2Zm88-27.21v-41.58L237.18 128Z\"/>"} />;

/** Phosphor stack (light) */
export const IconLayers = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M229.18 173a6 6 0 0 1-2.16 8.2l-96 56a6 6 0 0 1-6 0l-96-56a6 6 0 0 1 6-10.36l93 54.23l93-54.23a6 6 0 0 1 8.16 2.16M221 122.82l-93 54.23l-93-54.23a6 6 0 0 0-6 10.36l96 56a6 6 0 0 0 6 0l96-56a6 6 0 0 0-6-10.36M26 80a6 6 0 0 1 3-5.18l96-56a6 6 0 0 1 6 0l96 56a6 6 0 0 1 0 10.36l-96 56a6 6 0 0 1-6 0l-96-56A6 6 0 0 1 26 80m17.91 0L128 129.05L212.09 80L128 31Z\"/>"} />;

/** Phosphor robot (light) */
export const IconRobot = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M200 50h-66V16a6 6 0 0 0-12 0v34H56a30 30 0 0 0-30 30v112a30 30 0 0 0 30 30h144a30 30 0 0 0 30-30V80a30 30 0 0 0-30-30m18 142a18 18 0 0 1-18 18H56a18 18 0 0 1-18-18V80a18 18 0 0 1 18-18h144a18 18 0 0 1 18 18ZM74 108a10 10 0 1 1 10 10a10 10 0 0 1-10-10m88 0a10 10 0 1 1 10 10a10 10 0 0 1-10-10m2 30H92a26 26 0 0 0 0 52h72a26 26 0 0 0 0-52m-22 12v28h-28v-28Zm-64 14a14 14 0 0 1 14-14h10v28H92a14 14 0 0 1-14-14m86 14h-10v-28h10a14 14 0 0 1 0 28\"/>"} />;

/** Phosphor ranking (light) */
export const IconRanking = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M114.31 101.9a6 6 0 0 1 3.79-7.59l12-4A6 6 0 0 1 138 96v40a6 6 0 0 1-12 0v-31.68l-4.1 1.37a6 6 0 0 1-7.59-3.79M246 208a6 6 0 0 1-6 6H16a6 6 0 0 1 0-12h10v-98a14 14 0 0 1 14-14h42V56a14 14 0 0 1 14-14h64a14 14 0 0 1 14 14v74h42a14 14 0 0 1 14 14v58h10a6 6 0 0 1 6 6m-72-66v60h44v-58a2 2 0 0 0-2-2Zm-80 60h68V56a2 2 0 0 0-2-2H96a2 2 0 0 0-2 2Zm-56 0h44V102H40a2 2 0 0 0-2 2Z\"/>"} />;

/** Phosphor user-check (light) */
export const IconUserCheck = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M139 158.25a66 66 0 1 0-62 0c-22 6.23-41.88 19.16-57.61 37.89a6 6 0 0 0 9.18 7.72C49.11 179.44 77.31 166 108 166s58.9 13.44 79.41 37.86a6 6 0 1 0 9.18-7.72C180.86 177.41 161 164.48 139 158.25M54 100a54 54 0 1 1 54 54a54.06 54.06 0 0 1-54-54m198.24 32.24l-32 32a6 6 0 0 1-8.48 0l-16-16a6 6 0 0 1 8.48-8.48L216 151.51l27.76-27.75a6 6 0 1 1 8.48 8.48\"/>"} />;

/** Phosphor paper-plane-tilt (light) */
export const IconSent = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M225.88 30.12a13.83 13.83 0 0 0-13.7-3.58h-.11L20.14 84.77A14 14 0 0 0 18 110.85l85.56 41.64L145.12 238a13.87 13.87 0 0 0 12.61 8c.4 0 .81 0 1.21-.05a13.9 13.9 0 0 0 12.29-10.09l58.2-191.93v-.11a13.83 13.83 0 0 0-3.55-13.7m-8 10.4l-58.15 191.91v.11a2 2 0 0 1-3.76.26l-40.68-83.58l49-49a6 6 0 1 0-8.49-8.49l-49 49L23.15 100a2 2 0 0 1 .31-3.74h.11l191.91-58.18a1.94 1.94 0 0 1 1.92.52a2 2 0 0 1 .52 1.92Z\"/>"} />;

/** Phosphor cpu (light) */
export const IconAiChip = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M152 98h-48a6 6 0 0 0-6 6v48a6 6 0 0 0 6 6h48a6 6 0 0 0 6-6v-48a6 6 0 0 0-6-6m-6 48h-36v-36h36Zm86 0h-18v-36h18a6 6 0 0 0 0-12h-18V56a14 14 0 0 0-14-14h-42V24a6 6 0 0 0-12 0v18h-36V24a6 6 0 0 0-12 0v18H56a14 14 0 0 0-14 14v42H24a6 6 0 0 0 0 12h18v36H24a6 6 0 0 0 0 12h18v42a14 14 0 0 0 14 14h42v18a6 6 0 0 0 12 0v-18h36v18a6 6 0 0 0 12 0v-18h42a14 14 0 0 0 14-14v-42h18a6 6 0 0 0 0-12m-30 54a2 2 0 0 1-2 2H56a2 2 0 0 1-2-2V56a2 2 0 0 1 2-2h144a2 2 0 0 1 2 2Z\"/>"} />;

/** Phosphor database (light) */
export const IconDatabase = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M128 26c-52.71 0-94 23.72-94 54v96c0 30.28 41.29 54 94 54s94-23.72 94-54V80c0-30.28-41.29-54-94-54m0 12c44.45 0 82 19.23 82 42s-37.55 42-82 42s-82-19.23-82-42s37.55-42 82-42m82 138c0 22.77-37.55 42-82 42s-82-19.23-82-42v-21.21C62 171.16 92.37 182 128 182s66-10.84 82-27.21Zm0-48c0 22.77-37.55 42-82 42s-82-19.23-82-42v-21.21C62 123.16 92.37 134 128 134s66-10.84 82-27.21Z\"/>"} />;

/** Phosphor atom (light) */
export const IconAtom = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M193.83 128a195.7 195.7 0 0 0 19.9-33.65c10.74-23.88 11-42.66.8-52.88s-29-9.94-52.88.8A195.7 195.7 0 0 0 128 62.17a195.7 195.7 0 0 0-33.65-19.9c-23.88-10.74-42.66-11-52.88-.8s-9.94 29 .8 52.88A195.7 195.7 0 0 0 62.17 128a195.7 195.7 0 0 0-19.9 33.65c-10.74 23.88-11 42.66-.8 52.88c5 5 12 7.47 20.63 7.47c9.1 0 20-2.76 32.25-8.27a195.7 195.7 0 0 0 33.65-19.9a195.7 195.7 0 0 0 33.65 19.9c12.25 5.51 23.15 8.27 32.25 8.27c8.64 0 15.65-2.49 20.63-7.47c10.23-10.22 9.94-29-.8-52.88a195.7 195.7 0 0 0-19.9-33.65M206 50c9.28 9.28 2.36 36.29-19.8 68a306 306 0 0 0-22.78-25.45A306 306 0 0 0 138 69.76c31.75-22.15 58.77-29.08 68-19.76m-27.19 78A289 289 0 0 1 155 155a289 289 0 0 1-27 23.88A289 289 0 0 1 101 155a291 291 0 0 1-23.88-27A297 297 0 0 1 128 77.14A291 291 0 0 1 155 101a289 289 0 0 1 23.85 27ZM50 50c2.68-2.69 6.84-4 12.17-4c13.11 0 33.3 8 55.87 23.81a303 303 0 0 0-25.5 22.73A306 306 0 0 0 69.76 118C47.6 86.25 40.68 59.24 50 50m0 156c-9.28-9.28-2.35-36.29 19.8-68a306 306 0 0 0 22.78 25.45A306 306 0 0 0 118 186.24C86.25 208.4 59.24 215.32 50 206m156 0c-9.28 9.28-36.29 2.35-68-19.81a304 304 0 0 0 25.45-22.77A306 306 0 0 0 186.24 138c22.16 31.75 29.08 58.76 19.76 68m-68-78a10 10 0 1 1-10-10a10 10 0 0 1 10 10\"/>"} />;

/** Phosphor chart-line (light) */
export const IconChart = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M230 208a6 6 0 0 1-6 6H32a6 6 0 0 1-6-6V48a6 6 0 0 1 12 0v98.78l54.05-47.3a6 6 0 0 1 7.55-.28l60.11 45.08l60.34-52.8a6 6 0 0 1 7.9 9l-64 56a6 6 0 0 1-7.55.28l-60.11-45.04l-58.29 51V202h186a6 6 0 0 1 6 6\"/>"} />;

/** Phosphor corners-out (light) */
export const IconFullScreen = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M214 48v40a6 6 0 0 1-12 0V54h-34a6 6 0 0 1 0-12h40a6 6 0 0 1 6 6M88 202H54v-34a6 6 0 0 0-12 0v40a6 6 0 0 0 6 6h40a6 6 0 0 0 0-12m120-40a6 6 0 0 0-6 6v34h-34a6 6 0 0 0 0 12h40a6 6 0 0 0 6-6v-40a6 6 0 0 0-6-6M88 42H48a6 6 0 0 0-6 6v40a6 6 0 0 0 12 0V54h34a6 6 0 0 0 0-12\"/>"} />;

/** Phosphor magnifying-glass-plus (light) */
export const IconZoomIn = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M150 112a6 6 0 0 1-6 6h-26v26a6 6 0 0 1-12 0v-26H80a6 6 0 0 1 0-12h26V80a6 6 0 0 1 12 0v26h26a6 6 0 0 1 6 6m78.24 116.24a6 6 0 0 1-8.48 0l-51.38-51.38a86.15 86.15 0 1 1 8.48-8.48l51.38 51.38a6 6 0 0 1 0 8.48M112 186a74 74 0 1 0-74-74a74.09 74.09 0 0 0 74 74\"/>"} />;

/** Phosphor magnifying-glass-minus (light) */
export const IconZoomOut = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M150 112a6 6 0 0 1-6 6H80a6 6 0 0 1 0-12h64a6 6 0 0 1 6 6m78.24 116.24a6 6 0 0 1-8.48 0l-51.38-51.38a86.15 86.15 0 1 1 8.48-8.48l51.38 51.38a6 6 0 0 1 0 8.48M112 186a74 74 0 1 0-74-74a74.09 74.09 0 0 0 74 74\"/>"} />;

/** Phosphor flow-arrow (light) */
export const IconWorkflow = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"m244.24 75.76l-32-32a6 6 0 0 0-8.48 8.48L225.51 74H208c-48 0-59.44 27.46-69.54 51.69c-9.43 22.64-17.66 42.33-53 44.16a38 38 0 1 0 .06 12c43.34-2.06 54.29-28.29 64-51.55C159.44 106.53 168 86 208 86h17.51l-21.75 21.76a6 6 0 1 0 8.48 8.48l32-32a6 6 0 0 0 0-8.48M48 202a26 26 0 1 1 26-26a26 26 0 0 1-26 26\"/>"} />;

/** Phosphor squares-four (light) */
export const IconDashboard = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M104 42H56a14 14 0 0 0-14 14v48a14 14 0 0 0 14 14h48a14 14 0 0 0 14-14V56a14 14 0 0 0-14-14m2 62a2 2 0 0 1-2 2H56a2 2 0 0 1-2-2V56a2 2 0 0 1 2-2h48a2 2 0 0 1 2 2Zm94-62h-48a14 14 0 0 0-14 14v48a14 14 0 0 0 14 14h48a14 14 0 0 0 14-14V56a14 14 0 0 0-14-14m2 62a2 2 0 0 1-2 2h-48a2 2 0 0 1-2-2V56a2 2 0 0 1 2-2h48a2 2 0 0 1 2 2Zm-98 34H56a14 14 0 0 0-14 14v48a14 14 0 0 0 14 14h48a14 14 0 0 0 14-14v-48a14 14 0 0 0-14-14m2 62a2 2 0 0 1-2 2H56a2 2 0 0 1-2-2v-48a2 2 0 0 1 2-2h48a2 2 0 0 1 2 2Zm94-62h-48a14 14 0 0 0-14 14v48a14 14 0 0 0 14 14h48a14 14 0 0 0 14-14v-48a14 14 0 0 0-14-14m2 62a2 2 0 0 1-2 2h-48a2 2 0 0 1-2-2v-48a2 2 0 0 1 2-2h48a2 2 0 0 1 2 2Z\"/>"} />;

/** Phosphor exclamation-mark (light) */
export const IconExclamation = (p: P) => <Svg {...p} body={"<path fill=\"currentColor\" d=\"M142 200a14 14 0 1 1-14-14a14 14 0 0 1 14 14m-14-42a6 6 0 0 0 6-6V48a6 6 0 0 0-12 0v104a6 6 0 0 0 6 6\"/>"} />;

/**
 * Anthropic mark, from Simple Icons (CC0) via api.iconify.design, simple-icons:anthropic.
 * Drawn on a 24px grid, so it brings its own viewBox; colour comes from currentColor.
 */
export const IconAnthropic = (p: P) => <Svg viewBox="0 0 24 24" {...p} body={"<path fill=\"currentColor\" d=\"M17.304 3.541h-3.672l6.696 16.918H24Zm-10.608 0L0 20.459h3.744l1.37-3.553h7.005l1.369 3.553h3.744L10.536 3.541Zm-.371 10.223L8.616 7.82l2.291 5.945Z\"/>"} />;

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
