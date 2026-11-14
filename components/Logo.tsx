import { PRODUCT_NAME } from "@/lib/config";

/**
 * Mark: near-infrared light passing through the head. A ring with a tapered
 * beam entering at ~8 o'clock and reaching the far side at ~2 o'clock.
 * Same geometry as app/icon.svg.
 */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="9.6" fill="none" stroke="currentColor" strokeWidth="2.1" />
      <path d="M3.2 13.3 L20.4 8.6 L4.4 16.6 Z" fill="currentColor" strokeLinejoin="round" stroke="currentColor" strokeWidth="0.6" />
    </svg>
  );
}

export function Logo() {
  return (
    <div className="flex items-center gap-2.5 text-text">
      <LogoMark />
      <span className="font-display text-[22px] font-semibold leading-none tracking-[-0.04em]">{PRODUCT_NAME}</span>
    </div>
  );
}
