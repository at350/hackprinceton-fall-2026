import { PRODUCT_NAME } from "@/lib/config";

/** Mark: the brain from above, two hemispheres split by the fissure, with one scan spot. */
export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <svg width="20" height="24" viewBox="0 0 20 24" aria-hidden>
        <path d="M9 1.2C4.2 1.6 1 6 1 12s3.2 10.4 8 10.8Z" fill="var(--text)" />
        <path d="M11 1.2c4.8.4 8 4.8 8 10.8s-3.2 10.4-8 10.8Z" fill="var(--text)" fillOpacity="0.35" />
        <circle cx="4.6" cy="12" r="1.9" fill="var(--bg)" />
      </svg>
      <span className="text-[22px] font-semibold leading-none tracking-[-0.045em]">{PRODUCT_NAME}</span>
    </div>
  );
}
