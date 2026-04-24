"use client";

/**
 * VUMeter — a segmented level meter that fills proportionally to loudness.
 *
 * All segments light up together up to the current level, with a peak-hold
 * indicator on the loudest recent segment.
 *
 * Two modes:
 *   1. Data-driven: pass `level` (0..1). The meter fills to that level with
 *      fast-attack / slow-release smoothing.
 *   2. Idle: omit `level` and the meter simulates voice-like dynamics so it
 *      has something to show before mic permission is granted.
 *
 * When `active` is false the meter decays toward silence and dims.
 *
 * Color thresholds: green below roughly -9 dB, yellow -9..-1 dB, red at the top.
 *
 * Perf note: this component intentionally does NOT call setState on every
 * animation frame. The rAF loop mutates DOM styles directly through refs and
 * only calls setState when the lit segment index changes — so a busy meter
 * re-renders a handful of times per second instead of ~60.
 */

import { useEffect, useMemo, useRef, useState } from "react";

interface VUMeterProps {
  /** Live RMS level in [0, 1]. Optional — omit for idle simulation. */
  level?: number;
  /** When false the meter decays toward the floor. Defaults to true. */
  active?: boolean;
  /** Number of segments. 28–32 reads well at full width. */
  segments?: number;
  /** Pixel height of the meter. */
  height?: number;
}

export function VUMeter({
  level,
  active = true,
  segments = 32,
  height = 44,
}: VUMeterProps) {
  // Smoothed current level and held peak, both in [0, 1]
  const levelRef = useRef(0.08);
  const targetRef = useRef(0.12);
  const peakRef = useRef(0.08);
  const peakHoldRef = useRef(0);
  const tRef = useRef(0);
  const rafRef = useRef<number | undefined>(undefined);

  // Props fed into the animation loop via refs so the effect never tears down.
  const liveLevelRef = useRef<number | undefined>(level);
  const activeRef = useRef<boolean>(active);
  useEffect(() => {
    liveLevelRef.current = level;
  }, [level]);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  // One ref per segment — the animation loop flips their background/opacity
  // directly. We still need *some* reactive state so the component can mount
  // with a valid initial paint and update when the lit count crosses an
  // integer boundary, but that happens at a small handful of Hz, not 60.
  const segRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [litCount, setLitCount] = useState(0);
  const [peakIdx, setPeakIdx] = useState(-1);
  const lastLitRef = useRef(0);
  const lastPeakRef = useRef(-1);

  // Precompute per-segment color (doesn't depend on level)
  const segColors = useMemo(
    () =>
      Array.from({ length: segments }, (_, i) => {
        const frac = i / segments;
        return frac >= 0.88
          ? "var(--rec)"
          : frac >= 0.7
            ? "var(--warn)"
            : "var(--ok)";
      }),
    [segments],
  );

  useEffect(() => {
    const animate = () => {
      tRef.current += 0.04;
      const t = tRef.current;
      const live = liveLevelRef.current;
      const isActive = activeRef.current;

      if (!isActive) {
        levelRef.current *= 0.85;
        peakRef.current *= 0.96;
      } else if (typeof live === "number") {
        targetRef.current = Math.max(0, Math.min(1, live));
        const diff = targetRef.current - levelRef.current;
        levelRef.current += diff * (diff > 0 ? 0.35 : 0.09);

        if (levelRef.current >= peakRef.current) {
          peakRef.current = levelRef.current;
          peakHoldRef.current = 55;
        } else if (peakHoldRef.current > 0) {
          peakHoldRef.current -= 1;
        } else {
          peakRef.current *= 0.975;
        }
      } else {
        // Idle — voice-like dynamics
        if (Math.random() < 0.07) {
          const base = Math.abs(
            Math.sin(t * 0.9) * 0.48 +
              Math.sin(t * 2.3) * 0.22 +
              Math.sin(t * 0.4) * 0.15,
          );
          targetRef.current = Math.max(
            0.04,
            Math.min(0.97, base + Math.random() * 0.15),
          );
        }
        const diff = targetRef.current - levelRef.current;
        levelRef.current += diff * (diff > 0 ? 0.22 : 0.07);

        if (levelRef.current >= peakRef.current) {
          peakRef.current = levelRef.current;
          peakHoldRef.current = 55;
        } else if (peakHoldRef.current > 0) {
          peakHoldRef.current -= 1;
        } else {
          peakRef.current *= 0.975;
        }
      }

      const lvl = levelRef.current;
      const pk = peakRef.current;
      const nextLit = Math.round(lvl * segments);
      const nextPeak = pk > 0.08 ? Math.min(segments - 1, Math.round(pk * segments)) : -1;

      // Only reconcile through React when the integer indices actually change.
      if (nextLit !== lastLitRef.current || nextPeak !== lastPeakRef.current) {
        const prevLit = lastLitRef.current;
        const prevPeak = lastPeakRef.current;
        lastLitRef.current = nextLit;
        lastPeakRef.current = nextPeak;

        // Fast path — mutate the affected segments directly
        const lo = Math.min(prevLit, nextLit);
        const hi = Math.max(prevLit, nextLit);
        for (let i = lo; i < hi; i++) {
          const el = segRefs.current[i];
          if (!el) continue;
          const on = i < nextLit || i === nextPeak;
          el.style.background = on ? segColors[i] : "rgba(255,240,210,0.05)";
          el.style.boxShadow = on && isActive ? `0 0 4px ${segColors[i]}60` : "none";
        }
        if (prevPeak >= 0 && prevPeak !== nextPeak && prevPeak >= nextLit) {
          const el = segRefs.current[prevPeak];
          if (el) {
            el.style.background = "rgba(255,240,210,0.05)";
            el.style.boxShadow = "none";
          }
        }
        if (nextPeak >= 0 && nextPeak !== prevPeak && nextPeak >= nextLit) {
          const el = segRefs.current[nextPeak];
          if (el) {
            el.style.background = segColors[nextPeak];
            el.style.boxShadow = isActive ? `0 0 4px ${segColors[nextPeak]}60` : "none";
          }
        }

        // Keep reactive state in sync for correct re-hydration after other
        // re-renders (e.g. prop changes). This runs at most a few Hz.
        setLitCount(nextLit);
        setPeakIdx(nextPeak);
      }

      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [segments, segColors]);

  return (
    <div className="flex items-stretch gap-[2px]" style={{ height }}>
      {Array.from({ length: segments }).map((_, i) => {
        const on = i < litCount || i === peakIdx;
        return (
          <div
            key={i}
            ref={(el) => {
              segRefs.current[i] = el;
            }}
            className="flex-1 rounded-[2px]"
            style={{
              background: on ? segColors[i] : "rgba(255,240,210,0.05)",
              opacity: active ? 1 : 0.35,
              transition: "background 60ms ease",
              boxShadow: on && active ? `0 0 4px ${segColors[i]}60` : "none",
            }}
          />
        );
      })}
    </div>
  );
}

/** The -40 / -30 / ... / 0 dB tick labels shown under a VU meter. */
export function DbScale() {
  return (
    <div className="flex justify-between px-[1px]">
      {["-40", "-30", "-20", "-12", "-6", "0"].map((l) => (
        <span key={l} className="font-mono text-[9px] text-text-3">
          {l}
        </span>
      ))}
    </div>
  );
}
