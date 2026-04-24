"use client";

import { useCallback, type ChangeEvent } from "react";

const LS_ENABLED = "cozytrack:monitor-enabled";
const LS_VOLUME = "cozytrack:monitor-volume";

interface MicMonitorToggleProps {
  enabled: boolean;
  volume: number;
  onEnabledChange: (enabled: boolean) => void;
  onVolumeChange: (volume: number) => void;
}

export function getStoredMonitorEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(LS_ENABLED) === "true";
}

export function getStoredMonitorVolume(): number {
  if (typeof window === "undefined") return 70;
  const v = localStorage.getItem(LS_VOLUME);
  if (v === null) return 70;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 70;
}

export function MicMonitorToggle({
  enabled,
  volume,
  onEnabledChange,
  onVolumeChange,
}: MicMonitorToggleProps) {
  const handleToggle = useCallback(() => {
    const next = !enabled;
    localStorage.setItem(LS_ENABLED, String(next));
    onEnabledChange(next);
  }, [enabled, onEnabledChange]);

  const handleVolume = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const v = Number(e.target.value);
      localStorage.setItem(LS_VOLUME, String(v));
      onVolumeChange(v);
    },
    [onVolumeChange],
  );

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-labelledby="mic-monitor-label"
        onClick={handleToggle}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
          enabled ? "bg-amber" : ""
        }`}
        style={{ background: enabled ? "var(--amber)" : "var(--card-hi)" }}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
            enabled ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
      <span id="mic-monitor-label" className="text-[13px] text-text-2 select-none font-sans">
        Monitor my mic
      </span>

      {enabled && (
        <input
          type="range"
          min={0}
          max={100}
          value={volume}
          onChange={handleVolume}
          className="w-24 accent-amber"
          aria-label="Monitor volume"
        />
      )}

      <div className="relative group">
        <button
          type="button"
          aria-label="Headphone warning"
          aria-describedby="monitor-headphone-warning"
          className="text-text-3 cursor-help text-xs bg-transparent border-0 p-0"
        >
          &#9432;
        </button>
        <div
          id="monitor-headphone-warning"
          role="tooltip"
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block group-focus-within:block w-56 px-3 py-2 rounded-lg text-xs text-text-2 shadow-lg z-50 border"
          style={{ background: "var(--card-hi)", borderColor: "var(--border-hi)" }}
        >
          Use headphones &mdash; monitoring without headphones will cause
          feedback
        </div>
      </div>
    </div>
  );
}
