"use client";

import { motion } from "motion/react";
import { useEffect, useRef } from "react";
import { CHART_WINDOW_MS } from "@/lib/config";
import { DEVICE_BUFFER_CAP, deviceBuffer } from "@/lib/mock";
import { useDash } from "@/lib/useDash";
import { useLatestSample } from "@/lib/useDevice";
import { EASE_ENTER, QualityBadge } from "./ui";

/** Rolling 10 s line chart, drawn straight from the ring buffer every frame. */
function SignalChart({ series, minSpan, live }: { series: "coil" | "nir"; minSpan: number; live: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    let lo = 0;
    let hi = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = devicePixelRatio;
      const w = canvas.clientWidth * dpr;
      const h = canvas.clientHeight * dpr;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.clearRect(0, 0, w, h);

      // Faint dashed grid.
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = dpr;
      ctx.setLineDash([2 * dpr, 4 * dpr]);
      for (let i = 1; i < 4; i++) {
        const y = Math.round((h * i) / 4) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      const b = deviceBuffer;
      // Nothing to plot unless the device is streaming.
      if (!live || b.size < 2) return;
      const vals = series === "coil" ? b.coil : b.nir;
      const now = b.t[(b.head - 1 + DEVICE_BUFFER_CAP) % DEVICE_BUFFER_CAP];
      const from = now - CHART_WINDOW_MS;

      // Smoothly tracked y range.
      let mn = Infinity;
      let mx = -Infinity;
      for (let i = 0; i < b.size; i++) {
        const k = (b.head - 1 - i + DEVICE_BUFFER_CAP) % DEVICE_BUFFER_CAP;
        if (b.t[k] < from) break;
        mn = Math.min(mn, vals[k]);
        mx = Math.max(mx, vals[k]);
      }
      const mid = (mn + mx) / 2;
      const span = Math.max(minSpan, (mx - mn) * 1.3);
      const tlo = mid - span / 2;
      const thi = mid + span / 2;
      if (lo === hi) {
        lo = tlo;
        hi = thi;
      }
      lo += (tlo - lo) * 0.05;
      hi += (thi - hi) * 0.05;

      ctx.beginPath();
      let lastX = 0;
      let lastY = 0;
      let started = false;
      for (let i = b.size - 1; i >= 0; i--) {
        const k = (b.head - 1 - i + DEVICE_BUFFER_CAP) % DEVICE_BUFFER_CAP;
        if (b.t[k] < from) continue;
        const x = ((b.t[k] - from) / CHART_WINDOW_MS) * (w - 8 * dpr);
        const y = h - ((vals[k] - lo) / (hi - lo)) * h;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
        lastX = x;
        lastY = y;
      }
      ctx.strokeStyle = "rgba(237,238,240,0.85)";
      ctx.lineWidth = 1.25 * dpr;
      ctx.lineJoin = "round";
      ctx.stroke();

      // Live head of the trace.
      ctx.fillStyle = "#22c3e6";
      ctx.beginPath();
      ctx.arc(lastX, lastY, 2.5 * dpr, 0, Math.PI * 2);
      ctx.fill();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [series, minSpan, live]);
  return <canvas ref={ref} className="size-full" />;
}

function ChartRow({ label, unit, value, children }: { label: string; unit: string; value: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-stretch gap-4">
      <div className="flex w-[92px] shrink-0 flex-col justify-center gap-1.5">
        <span className="text-[13px] text-muted">{label}</span>
        <span className="flex items-baseline gap-1">
          <span className="text-[24px] font-medium leading-none tracking-[-0.04em] text-text">{value}</span>
          <span className="text-[12px] text-muted">{unit}</span>
        </span>
      </div>
      <div className="relative min-h-0 flex-1 py-1">{children}</div>
    </div>
  );
}

export function LiveData() {
  const device = useDash((s) => s.device);
  const quality = useDash((s) => s.quality);
  const live = device !== "disconnected";
  const latest = useLatestSample(live);

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: EASE_ENTER, delay: 0.1 }}
      className="surface raised relative flex h-[284px] shrink-0 flex-col gap-2 p-4"
    >
      <ChartRow label="Coil" unit="dB" value={latest ? latest.coil_db.toFixed(1) : "--"}>
        <SignalChart series="coil" minSpan={3} live={live} />
      </ChartRow>
      <ChartRow label="NIR" unit="a.u." value={latest ? latest.nir.toFixed(3) : "--"}>
        <SignalChart series="nir" minSpan={0.06} live={live} />
      </ChartRow>
      <div className="flex items-center justify-between gap-3 border-t border-[rgba(255,255,255,0.06)] pt-3">
        {/* Tilt is shown on the brain view, at the active spot; here it is just the number. */}
        <span className="text-[13px] text-muted">
          Tilt{" "}
          <span className="font-medium text-text">
            {live && latest ? `${Math.round(Math.hypot(latest.imu.pitch, latest.imu.roll))}°` : "--"}
          </span>
        </span>
        {live && latest !== null && <QualityBadge quality={quality} live />}
      </div>
    </motion.section>
  );
}
