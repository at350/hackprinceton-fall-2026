import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Bleed likely: warning triangle. */
export const IconAlert = (p: P) => (
  <Svg {...p}>
    <path d="M8 2.2 14.3 13.2H1.7Z" />
    <path d="M8 6.4v3.2M8 11.4v.1" />
  </Svg>
);

/** Uncertain: question in circle. */
export const IconQuestion = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M6.3 6.3a1.8 1.8 0 1 1 2.5 1.6c-.5.2-.8.6-.8 1.1v.4M8 11.3v.1" />
  </Svg>
);

/** No bleed seen: shield with check. */
export const IconShieldCheck = (p: P) => (
  <Svg {...p}>
    <path d="M8 1.8 13 3.6v4c0 3.1-2.1 5.4-5 6.6-2.9-1.2-5-3.5-5-6.6v-4Z" />
    <path d="m5.8 8 1.5 1.5 3-3" />
  </Svg>
);

export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="m3.5 8.3 2.8 2.8 6.2-6.2" />
  </Svg>
);

export const IconX = (p: P) => (
  <Svg {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Svg>
);

export const IconClock = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M8 4.8V8l2.2 1.4" />
  </Svg>
);

export const IconInfo = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M8 7.2v4M8 4.9v.1" />
  </Svg>
);

export const IconArrowRight = (p: P) => (
  <Svg {...p}>
    <path d="M3 8h10M9 4l4 4-4 4" />
  </Svg>
);

export const IconArrowUp = (p: P) => (
  <Svg {...p}>
    <path d="M8 13V3M4 7l4-4 4 4" />
  </Svg>
);

export const IconPlay = (p: P) => (
  <Svg {...p}>
    <path d="M5 3.2v9.6L12.5 8Z" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconPause = (p: P) => (
  <Svg {...p}>
    <path d="M5.5 3.5v9M10.5 3.5v9" strokeWidth={1.8} />
  </Svg>
);

export const IconRestart = (p: P) => (
  <Svg {...p}>
    <path d="M3 8a5 5 0 1 0 1.5-3.6M3 2.5v2.4h2.4" />
  </Svg>
);

export const IconPlug = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 13.5 5 11M6 6 10 10M9.5 3.5 12.5 6.5M5 11a3 3 0 0 0 4.3 0l1.2-1.2L6.2 5.5 5 6.7A3 3 0 0 0 5 11Z" />
    <path d="M2 2l12 12" />
  </Svg>
);

export const IconTool = (p: P) => (
  <Svg {...p}>
    <path d="m3 5 3 3-3 3M8 11.5h5" />
  </Svg>
);

export const IconTarget = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
    <circle cx="8" cy="8" r="2.6" />
    <circle cx="8" cy="8" r=".4" fill="currentColor" />
  </Svg>
);

export const IconHand = (p: P) => (
  <Svg {...p}>
    <path d="M5.5 8V3.8a1 1 0 0 1 2 0V7.5M7.5 7V2.8a1 1 0 0 1 2 0V7M9.5 7V3.8a1 1 0 0 1 2 0v5.4c0 2.7-1.8 4.8-4.4 4.8-1.4 0-2.4-.6-3.2-1.8L2.6 9.8a1 1 0 0 1 1.6-1.2l1.3 1.2" />
  </Svg>
);

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

export function Wave({ className = "", height = 12 }: { className?: string; height?: number }) {
  return (
    <span className={`wave inline-flex items-center gap-[2px] ${className}`} style={{ height }} aria-hidden>
      <span style={{ height }} />
      <span style={{ height }} />
      <span style={{ height }} />
      <span style={{ height }} />
    </span>
  );
}
