"use client";

export type ParticipantReadinessStatus = "ready" | "not_ready";
export type ParticipantRecordingStatus =
  | "connected"
  | "recording"
  | "finalizing"
  | "complete"
  | "failed";

export type RecordingTakeState = {
  active: boolean;
  sessionStartedAt: string | null;
  take: {
    id: string;
    sessionId: string;
    startedAt: string;
    stoppedAt: string | null;
  } | null;
};

async function parseError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (typeof data?.error === "string") return data.error;
  } catch {
    // Fall back to status text below.
  }
  return res.statusText;
}

async function jsonRequest<T>(
  path: string,
  method: "PATCH" | "POST",
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(await parseError(res));
  }

  return (await res.json()) as T;
}

export async function getRecordingTakeState(
  sessionId: string,
): Promise<RecordingTakeState> {
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/recording-state`,
  );

  if (!res.ok) {
    throw new Error(await parseError(res));
  }

  return (await res.json()) as RecordingTakeState;
}

export async function startRecordingTake(
  sessionId: string,
  sessionStartedAt: string,
): Promise<RecordingTakeState> {
  return await jsonRequest<RecordingTakeState>(
    `/api/sessions/${encodeURIComponent(sessionId)}/recording-state`,
    "POST",
    { active: true, sessionStartedAt },
  );
}

export async function stopRecordingTake(
  sessionId: string,
): Promise<RecordingTakeState> {
  return await jsonRequest<RecordingTakeState>(
    `/api/sessions/${encodeURIComponent(sessionId)}/recording-state`,
    "POST",
    { active: false },
  );
}

export async function reportRecordingTakeParticipantStatus(
  sessionId: string,
  input: {
    takeId?: string | null;
    participantName?: string;
    readinessStatus?: ParticipantReadinessStatus | null;
    recordingStatus?: ParticipantRecordingStatus | null;
    reason?: string | null;
  },
): Promise<void> {
  await jsonRequest(
    `/api/sessions/${encodeURIComponent(sessionId)}/recording-state`,
    "PATCH",
    input,
  );
}
