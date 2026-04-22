"use client";

export interface DeviceInfo {
  deviceLabel: string;
  deviceId: string;
  isBuiltInMic: boolean;
}

export async function getPresignedUploadUrl(
  sessionId: string,
  trackId: string,
  partNumber: number,
  participantName?: string,
  deviceInfo?: DeviceInfo,
): Promise<string> {
  const res = await fetch("/api/upload/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      trackId,
      partNumber,
      participantName,
      ...deviceInfo,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to get presigned URL: ${res.statusText}`);
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
