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

export async function getPresignedUploadUrl(
  sessionId: string,
  trackId: string,
  partNumber: number,
  participantName?: string,
  trackInit?: TrackInitInfo,
): Promise<string> {
  const res = await fetch("/api/upload/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  return data.url;
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
  durationMs?: number
): Promise<void> {
  const res = await fetch("/api/upload/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, trackId, durationMs }),
  });

  if (!res.ok) {
    throw new Error(`Failed to complete upload: ${res.statusText}`);
  }
}
