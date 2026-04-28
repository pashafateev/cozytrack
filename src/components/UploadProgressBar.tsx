"use client";

import type { UploadProgress } from "@/hooks/useUploadProgress";

type UploadPhase = "idle" | "uploading" | "done" | "error";

function getPhase(progress: UploadProgress, recordingStopped: boolean): UploadPhase {
  if (progress.lastError) return "error";
  if (progress.bytesRecorded === 0) return "idle";
  if (recordingStopped && progress.fraction >= 1 && progress.chunksInFlight === 0)
    return "done";
  return "uploading";
}

export function UploadProgressBar({
  progress,
  recordingStopped,
}: {
  progress: UploadProgress;
  recordingStopped: boolean;
}) {
  const phase = getPhase(progress, recordingStopped);
  const pct = Math.round(progress.fraction * 100);

  // Colors per phase.
  const barColor: Record<UploadPhase, string> = {
    idle: "var(--border)",
    uploading: "var(--amber)",
    done: "var(--ok)",
    error: "var(--rec)",
  };

  const labelColor: Record<UploadPhase, string> = {
    idle: "var(--text-3)",
    uploading: "var(--amber)",
    done: "var(--ok)",
    error: "var(--rec)",
  };

  const label: Record<UploadPhase, string> = {
    idle: "—",
    uploading:
      progress.chunksInFlight > 0
        ? `${pct}% · ${progress.chunksInFlight} chunk${progress.chunksInFlight > 1 ? "s" : ""}`
        : `${pct}%`,
    done: "done",
    error: progress.lastError ?? "error",
  };

  return (
    <div className="w-full px-3 flex flex-col gap-1.5 items-center mb-5">
      <span
        className="font-mono text-[9px] tracking-[0.08em] font-medium"
        style={{ color: labelColor[phase] }}
      >
        UPLOAD
      </span>
      <div
        className="w-full h-1 rounded-[2px] overflow-hidden"
        style={{ background: "var(--border)" }}
      >
        <div
          className={`h-full rounded-[2px] transition-[width] duration-500 ease-out${
            phase === "uploading" ? " upload-bar-pulse" : ""
          }`}
          style={{
            width: phase === "idle" ? "0%" : `${Math.max(pct, 2)}%`,
            background: barColor[phase],
          }}
        />
      </div>
      <span
        className="font-mono text-[9px] truncate max-w-full"
        style={{ color: labelColor[phase] }}
      >
        {label[phase]}
      </span>
    </div>
  );
}
