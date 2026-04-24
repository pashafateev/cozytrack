"use client";

/**
 * Status pill used in participant strips and wherever we need to show a
 * compact "is this track connected / recording / uploading?" indicator.
 */

type Status = "connected" | "recording" | "uploading" | "failed" | "idle";

const MAP: Record<Status, { label: string; color: string; blink: boolean }> = {
  connected: { label: "Connected", color: "var(--ok)",   blink: false },
  recording: { label: "Recording", color: "var(--rec)",  blink: true  },
  uploading: { label: "Uploading…",color: "var(--warn)", blink: false },
  failed:    { label: "Failed",    color: "var(--rec)",  blink: false },
  idle:      { label: "Idle",      color: "var(--text-3)",blink: false },
};

export function StatusDot({ status }: { status: Status }) {
  const { label, color, blink } = MAP[status] ?? MAP.idle;
  return (
    <div className="flex items-center gap-1.5">
      <div
        className={`w-1.5 h-1.5 rounded-full ${blink ? "animate-blink" : ""}`}
        style={{ background: color }}
      />
      <span
        className="font-mono text-[11px] font-medium tracking-[0.04em]"
        style={{ color }}
      >
        {label}
      </span>
    </div>
  );
}

export type { Status };
