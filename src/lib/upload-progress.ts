import type { UploadProgress } from "@/hooks/useUploadProgress";

export type UploadPhase = "idle" | "uploading" | "done" | "error";

export function getUploadPhase(
  progress: UploadProgress,
  recordingStopped: boolean,
): UploadPhase {
  if (progress.lastError) return "error";
  if (progress.bytesRecorded === 0) return "idle";
  if (recordingStopped && progress.fraction >= 1 && progress.chunksInFlight === 0)
    return "done";
  return "uploading";
}
