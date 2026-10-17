"use client";

import {
  recordUploadDiagnostic,
  type UploadDiagnosticContext,
} from "@/lib/upload-diagnostics";
import type { UploadDiagnosticEvent } from "@/lib/upload-diagnostic-event";

// Diagnostics are observational: failures must never affect recording/upload.
function report(
  context: UploadDiagnosticContext | undefined,
  details: Parameters<typeof recordUploadDiagnostic>[1],
): void {
  if (!context) return;
  try { recordUploadDiagnostic(context, details); } catch { /* Best effort. */ }
}

function errorCategory(error: unknown): UploadDiagnosticEvent["errorCategory"] {
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  return error instanceof TypeError ? "network" : "unknown";
}

async function diagnosticFetch(
  url: string,
  init: RequestInit,
  context: UploadDiagnosticContext | undefined,
  stage: "presign" | "put" | "complete",
  bytes?: number,
): Promise<{ response: Response; elapsedMs: number }> {
  const started = Date.now();
  report(context, { stage, outcome: "started", bytes });
  try {
    const response = await fetch(url, init);
    return { response, elapsedMs: Math.max(0, Date.now() - started) };
  } catch (error) {
    report(context, { stage, outcome: "failed", bytes,
      elapsedMs: Math.max(0, Date.now() - started), errorCategory: errorCategory(error) });
    throw error;
  }
}

export interface DeviceInfo {
  deviceLabel: string | undefined;
  deviceId: string;
  isBuiltInMic: boolean;
}

export interface TrackInitInfo {
  deviceInfo?: DeviceInfo;
  // ISO8601 — the originator's local clock at the moment recording started.
  // Shared across all tracks triggered by the same broadcast.
  sessionStartedAt?: string;
  segmentId?: string;
  // The take this recording was broadcast for. Binds a delayed start to its
  // original take instead of whatever take is active when presign arrives.
  takeId?: string;
  // Host-only local channel slot (issue #135). When set, the server derives a
  // stable synthetic participant id from it so a split desktop channel records
  // as its own logical track. Guests supplying this are rejected.
  localTrackSlotId?: string;
}

export interface PresignedUploadTarget {
  url: string;
  key?: string;
  recordingToken?: string;
  trackId?: string;
  segmentId?: string;
}

export async function getPresignedUploadTarget(
  sessionId: string,
  trackId: string,
  partNumber: number,
  participantName?: string,
  trackInit?: TrackInitInfo,
  recordingToken?: string,
  diagnosticContext?: UploadDiagnosticContext,
): Promise<PresignedUploadTarget> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (recordingToken) {
    headers["X-Cozytrack-Recording-Token"] = recordingToken;
  }

  const { response: res, elapsedMs } = await diagnosticFetch("/api/upload/presign", {
    method: "POST",
    headers,
    body: JSON.stringify({
      sessionId,
      trackId,
      partNumber,
      participantName,
      ...(trackInit?.deviceInfo ?? {}),
      sessionStartedAt: trackInit?.sessionStartedAt,
      segmentId: trackInit?.segmentId,
      takeId: trackInit?.takeId,
      localTrackSlotId: trackInit?.localTrackSlotId,
      diagnosticAttemptId: diagnosticContext?.attemptId,
    }),
  }, diagnosticContext, "presign");

  if (!res.ok) {
    report(diagnosticContext, { stage: "presign", outcome: "failed", elapsedMs,
      httpStatus: res.status, errorCategory: "http" });
    let message = res.statusText;

    try {
      const data = await res.json();
      if (typeof data?.error === "string") {
        message = data.error;
      }
    } catch {
      // Fall back to the HTTP status text when the response isn't JSON.
    }

    throw new Error(`Failed to get presigned URL: ${message}`);
  }

  let data;
  try { data = await res.json(); } catch (error) {
    report(diagnosticContext, { stage: "presign", outcome: "failed", elapsedMs,
      httpStatus: res.status, errorCategory: "unknown" });
    throw error;
  }
  report(diagnosticContext, { stage: "presign", outcome: "succeeded", elapsedMs,
    httpStatus: res.status });
  return {
    url: data.url,
    key: typeof data.key === "string" ? data.key : undefined,
    recordingToken:
      typeof data.recordingToken === "string" ? data.recordingToken : undefined,
    trackId: typeof data.trackId === "string" ? data.trackId : undefined,
    segmentId: typeof data.segmentId === "string" ? data.segmentId : undefined,
  };
}

export async function getPresignedUploadUrl(
  sessionId: string,
  trackId: string,
  partNumber: number,
  participantName?: string,
  trackInit?: TrackInitInfo,
  recordingToken?: string,
  diagnosticContext?: UploadDiagnosticContext,
): Promise<string> {
  const target = await getPresignedUploadTarget(
    sessionId,
    trackId,
    partNumber,
    participantName,
    trackInit,
    recordingToken,
    diagnosticContext,
  );
  return target.url;
}

export async function uploadChunk(
  url: string, chunk: Blob, diagnosticContext?: UploadDiagnosticContext,
): Promise<void> {
  let createOnly = false;
  try {
    createOnly =
      new URL(url).searchParams
        .get("X-Amz-SignedHeaders")
        ?.split(";")
        .includes("if-none-match") ?? false;
  } catch {
    // Non-presigned URLs retain the existing upload behavior.
  }

  const { response: res, elapsedMs } = await diagnosticFetch(url, {
    method: "PUT",
    body: chunk,
    headers: {
      "Content-Type": "audio/webm",
      ...(createOnly ? { "If-None-Match": "*" } : {}),
    },
  }, diagnosticContext, "put", chunk.size);

  // A create-only final upload is safe to retry: 412 means the first PUT
  // already created the immutable recording object.
  if (createOnly && res.status === 412) {
    report(diagnosticContext, { stage: "put", outcome: "already_exists", elapsedMs,
      bytes: chunk.size, httpStatus: res.status });
    return;
  }

  if (!res.ok) {
    report(diagnosticContext, { stage: "put", outcome: "failed", elapsedMs,
      bytes: chunk.size, httpStatus: res.status, errorCategory: "http" });
    throw new Error(`Failed to upload chunk: ${res.statusText}`);
  }
  report(diagnosticContext, { stage: "put", outcome: "succeeded", elapsedMs,
    bytes: chunk.size, httpStatus: res.status });
}

export async function completeUpload(
  sessionId: string,
  trackId: string,
  durationMs?: number,
  recordingToken?: string,
  segmentId?: string,
  diagnosticContext?: UploadDiagnosticContext,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (recordingToken) {
    headers["X-Cozytrack-Recording-Token"] = recordingToken;
  }

  const { response: res, elapsedMs } = await diagnosticFetch("/api/upload/complete", {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId, trackId, durationMs, segmentId,
      diagnosticAttemptId: diagnosticContext?.attemptId }),
  }, diagnosticContext, "complete");

  if (!res.ok) {
    report(diagnosticContext, { stage: "complete", outcome: "failed", elapsedMs,
      httpStatus: res.status, errorCategory: "http" });
    throw new Error(`Failed to complete upload: ${res.statusText}`);
  }
  report(diagnosticContext, { stage: "complete", outcome: "succeeded", elapsedMs,
    httpStatus: res.status });
  if (diagnosticContext) {
    try {
      // Completion previously depended only on HTTP status. Inspect metadata
      // independently so a slow body cannot delay or change that behavior.
      void res.clone().json().then((data) => {
        if (["recording", "uploading", "complete", "failed"].includes(data?.status)) {
          report(diagnosticContext, { stage: "complete", outcome: "succeeded", elapsedMs,
            httpStatus: res.status, trackStatus: data.status });
        }
      }).catch(() => {});
    } catch { /* The response body is optional; preserve completion behavior. */ }
  }
}
