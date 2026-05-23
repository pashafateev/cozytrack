"use client";

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
}

export interface PresignedUploadTarget {
  url: string;
  recordingToken?: string;
}

export async function getPresignedUploadTarget(
  sessionId: string,
  trackId: string,
  partNumber: number,
  participantName?: string,
  trackInit?: TrackInitInfo,
  recordingToken?: string,
): Promise<PresignedUploadTarget> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (recordingToken) {
    headers["X-Cozytrack-Recording-Token"] = recordingToken;
  }

  const res = await fetch("/api/upload/presign", {
    method: "POST",
    headers,
    body: JSON.stringify({
      sessionId,
      trackId,
      partNumber,
      participantName,
      ...(trackInit?.deviceInfo ?? {}),
      sessionStartedAt: trackInit?.sessionStartedAt,
    }),
  });

  if (!res.ok) {
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

  const data = await res.json();
  return {
    url: data.url,
    recordingToken:
      typeof data.recordingToken === "string" ? data.recordingToken : undefined,
  };
}

export async function getPresignedUploadUrl(
  sessionId: string,
  trackId: string,
  partNumber: number,
  participantName?: string,
  trackInit?: TrackInitInfo,
  recordingToken?: string,
): Promise<string> {
  const target = await getPresignedUploadTarget(
    sessionId,
    trackId,
    partNumber,
    participantName,
    trackInit,
    recordingToken,
  );
  return target.url;
}

export async function uploadChunk(url: string, chunk: Blob): Promise<void> {
  const res = await fetch(url, {
    method: "PUT",
    body: chunk,
    headers: {
      "Content-Type": "audio/webm",
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to upload chunk: ${res.statusText}`);
  }
}

export async function completeUpload(
  sessionId: string,
  trackId: string,
  durationMs?: number,
  recordingToken?: string,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (recordingToken) {
    headers["X-Cozytrack-Recording-Token"] = recordingToken;
  }

  const res = await fetch("/api/upload/complete", {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId, trackId, durationMs }),
  });

  if (!res.ok) {
    throw new Error(`Failed to complete upload: ${res.statusText}`);
  }
}
