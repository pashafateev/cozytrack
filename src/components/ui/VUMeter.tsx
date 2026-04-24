"use client";

/**
 * VUMeter — a segmented level meter that fills proportionally to loudness.
 *
 * All segments light up together up to the current level (not each bar moving
 * independently). A peak-hold indicator sits at the loudest recent segment.
 *
 * Two modes:
 *   1. Data-driven: pass `level` (0..1). The meter fills to that level with
 *      fast-attack / slow-release smoothing. Used once a real mic stream is
 *      wired up in the studio.
 *   2. Idle simulation: omit `level` and the meter simulates voice-like
 *      dynamics so it has something to show before mic permission is granted.
 *
 * When `active` is false the meter decays toward silence and dims.
 *
 * Color thresholds match the design tokens — green below roughly -9 dB,
 * yellow -9..-1 dB, red at the very top.
 */

import { useEffect, useRef, useState } from "react";

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
  const peakHoldRef = useRef(0); // frames remaining to hold the peak
  const tRef = useRef(0);
  const rafRef = useRef<number | undefined>(undefined);

  // Keep the latest props in refs so the animation effect never needs to
  // tear down its requestAnimationFrame loop when `level`/`active` changes.
  const liveLevelRef = useRef<number | undefined>(level);
  const activeRef = useRef<boolean>(active);
  useEffect(() => {
    liveLevelRef.current = level;
  }, [level]);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const [display, setDisplay] = useState<{ level: number; peak: number }>(
    { level: levelRef.current, peak: peakRef.current },
  );

  useEffect(() => {
    const animate = () => {
      tRef.current += 0.04;
      const t = tRef.current;
      const live = liveLevelRef.current;
      const isActive = activeRef.current;

      if (!isActive) {
        // Decay to silence
        levelRef.current *= 0.85;
        peakRef.current *= 0.96;
      } else if (typeof live === "number") {
        // Real data — clamp and set as the attack/release target
        targetRef.current = Math.max(0, Math.min(1, live));
        const diff = targetRef.current - levelRef.current;
        // Fast attack, slower release
        levelRef.current += diff * (diff > 0 ? 0.35 : 0.09);

        // Peak hold
        if (levelRef.current >= peakRef.current) {
          peakRef.current = levelRef.current;
          peakHoldRef.current = 55;
        } else if (peakHoldRef.current > 0) {
          peakHoldRef.current -= 1;
        } else {
          peakRef.current *= 0.975;
        }
      } else {
        // Idle simulation — voice-like dynamics
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

      setDisplay({ level: levelRef.current, peak: peakRef.current });
      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // Intentionally empty deps — the loop runs for the life of the component
    // and reads level/active from refs on every frame.
  }, []);

  const { level: lvl, peak } = display;
  const litCount = Math.round(lvl * segments);
  const peakIdx = Math.min(segments - 1, Math.round(peak * segments));
  const showPeak = peak > 0.08;

  return (
    <div className="flex items-stretch gap-[2px]" style={{ height }}>
      {Array.from({ length: segments }).map((_, i) => {
        const frac = i / segments;
        const isLit = i < litCount;
        const isPeak = showPeak && i === peakIdx;
        const color =
          frac >= 0.88
            ? "var(--rec)"
            : frac >= 0.7
              ? "var(--warn)"
              : "var(--ok)";
        const on = isLit || isPeak;
        return (
          <div
            key={i}
            className="flex-1 rounded-[2px]"
            style={{
              background: on ? color : "rgba(255,240,210,0.05)",
              opacity: on ? (active ? 1 : 0.35) : 1,
              transition: "background 60ms ease",
              boxShadow: on && active ? `0 0 4px ${color}60` : "none",
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
