"use client";

import { useCallback } from "react";

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
    (e: React.ChangeEvent<HTMLInputElement>) => {
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
        onClick={handleToggle}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
          enabled ? "bg-indigo-600" : "bg-cozy-700"
        }`}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
            enabled ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
      <span className="text-sm text-gray-300 select-none">Monitor my mic</span>

      {enabled && (
        <input
          type="range"
          min={0}
          max={100}
          value={volume}
          onChange={handleVolume}
          className="w-24 accent-indigo-500"
          aria-label="Monitor volume"
        />
      )}

      <div className="relative group">
        <span className="text-gray-500 cursor-help text-xs">&#9432;</span>
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block w-56 px-3 py-2 rounded-lg bg-cozy-800 border border-cozy-600 text-xs text-gray-300 shadow-lg z-50">
          Use headphones &mdash; monitoring without headphones will cause
          feedback
        </div>
      </div>
    </div>
  );
}
