"use client";

/**
 * VUMeter — a horizontally-arranged bar graph that visualizes mic level.
 *
 * Two modes:
 *   1. Data-driven: pass `level` (0..1). Every bar tracks the same source with
 *      a small positional jitter so it still looks alive. This is what the
 *      studio uses once a real mic stream is available.
 *   2. Idle: pass `active={false}` (or no level) and the meter shows a low,
 *      gently-breathing floor. Useful before the user has granted mic access.
 *
 * Color thresholds match the design tokens — green under -12dB, yellow in the
 * -12..-3 range, red above.
 */

import { useEffect, useRef, useState } from "react";

interface VUMeterProps {
  /** Live RMS level in the range [0, 1]. Optional — omit for idle animation. */
  level?: number;
  /** When false the meter decays toward the floor. Defaults to true. */
  active?: boolean;
  /** Number of bars. 22–28 reads well at full width. */
  bars?: number;
  /** Pixel height of the bar column. */
  height?: number;
}

export function VUMeter({ level, active = true, bars = 24, height = 44 }: VUMeterProps) {
  const levelsRef = useRef<number[]>(
    Array.from({ length: bars }, () => 0.05 + Math.random() * 0.08),
  );
  const [levels, setLevels] = useState<number[]>(() => [...levelsRef.current]);
  const rafRef = useRef<number | undefined>(undefined);
  const tRef = useRef(0);

  useEffect(() => {
    // Resize if consumer changes `bars` at runtime
    if (levelsRef.current.length !== bars) {
      levelsRef.current = Array.from({ length: bars }, () => 0.05 + Math.random() * 0.08);
    }

    const animate = () => {
      tRef.current += 0.035;
      const t = tRef.current;
      const targetBase =
        !active ? 0.04
        : typeof level === "number"
            ? Math.max(0.04, Math.min(1, level))
            : Math.abs(Math.sin(t * 1.1) * 0.45 + Math.sin(t * 0.7) * 0.2);

      levelsRef.current = levelsRef.current.map((v, i) => {
        // Add per-bar variation so columns don't move in lockstep
        const jitter = typeof level === "number"
          ? (Math.sin(t * 2.1 + i * 0.9) * 0.08) + (Math.random() - 0.5) * 0.03
          : (Math.sin(t * 1.3 + i * 0.28) * 0.25);
        const target = Math.max(0.04, Math.min(1, targetBase + jitter));
        return v + (target - v) * 0.18;
      });
      setLevels([...levelsRef.current]);
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [active, level, bars]);

  return (
    <div className="flex items-end gap-0.5" style={{ height }}>
      {levels.map((l, i) => {
        const pct = Math.max(4, l * 100);
        const color =
          l > 0.88 ? "var(--rec)" : l > 0.68 ? "var(--warn)" : "var(--ok)";
        return (
          <div
            key={i}
            className="flex-1 h-full flex flex-col justify-end rounded-[2px] overflow-hidden"
            style={{ background: "rgba(255,240,210,0.04)" }}
          >
            <div
              style={{
                width: "100%",
                height: `${pct}%`,
                background: color,
                opacity: active ? 1 : 0.3,
                borderRadius: 2,
                transition: "height 55ms ease, background-color 120ms ease",
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

/** The -40 / -30 / ... / 0 dB tick labels shown under a VU meter. */
export function DbScale() {
  return (
    <div className="flex justify-between -mt-1">
      {["-40", "-30", "-20", "-12", "-6", "0"].map((l) => (
        <span key={l} className="font-mono text-[9px] text-text-3">
          {l}
        </span>
      ))}
    </div>
  );
}
