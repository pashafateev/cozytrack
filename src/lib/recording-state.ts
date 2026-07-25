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
  recoveryPending?: boolean;
  take: {
    id: string;
    sessionId: string;
    startedAt: string;
    stoppedAt: string | null;
    status: string;
  } | null;
};

// Carries the HTTP status so callers can decide whether a failure is worth
// retrying (5xx and network errors are; 4xx are not).
export class RecordingStateError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "RecordingStateError";
    this.status = status;
  }
}

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
    throw new RecordingStateError(await parseError(res), res.status);
  }

  return (await res.json()) as T;
}

const STOP_MAX_ATTEMPTS = 5;
const STOP_RETRY_BASE_MS = 300;

function isRetryableStopError(error: unknown): boolean {
  // Network/fetch rejections have no HTTP status — always worth retrying.
  if (!(error instanceof RecordingStateError)) return true;
  if (error.status === undefined) return true;
  // Server errors are transient; client errors (403/404/400) are not.
  return error.status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryPendingStopRecovery(
  path: string,
  body: Record<string, unknown>,
  maxAttempts: number,
  baseDelay: number,
): Promise<void> {
  for (let attempt = 2; attempt <= maxAttempts; attempt += 1) {
    await delay(baseDelay * (attempt - 1));

    try {
      const state = await jsonRequest<RecordingTakeState>(path, "POST", body);
      if (!state.recoveryPending) return;
    } catch (error) {
      if (!isRetryableStopError(error)) {
        console.error("Stopped take recovery retry failed", error);
        return;
      }
    }
  }

  console.error("Stopped take recovery remained pending after retry attempts");
}

// Read the authoritative recording state for a session. Used by the studio
// page's reconnect catch-up: a participant returning mid-take asks whether a
// take is still `recording` and, if so, resumes it. GET has no side effects, so
// there's nothing to retry — a transient failure just means we skip catch-up
// this time and the caller can try again on the next connect.
export async function getRecordingTakeState(
  sessionId: string,
): Promise<RecordingTakeState> {
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/recording-state`,
  );

  if (!res.ok) {
    throw new RecordingStateError(await parseError(res), res.status);
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

// Stopping must be durable: a transient failure here previously left the room's
// take active server-side, which let returning/new participants resume a
// recording the host had already ended. The stop endpoint is idempotent, so we
// retry transient failures until the stop is confirmed (or attempts run out).
export async function stopRecordingTake(
  sessionId: string,
  options: {
    maxAttempts?: number;
    retryDelayMs?: number;
    takeId?: string;
  } = {},
): Promise<RecordingTakeState> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? STOP_MAX_ATTEMPTS);
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/recording-state`;
  const body = {
    active: false,
    ...(options.takeId ? { takeId: options.takeId } : {}),
  };
  const baseDelay = options.retryDelayMs ?? STOP_RETRY_BASE_MS;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const state = await jsonRequest<RecordingTakeState>(path, "POST", body);
      if (state.recoveryPending && attempt < maxAttempts) {
        void retryPendingStopRecovery(
          path,
          body,
          maxAttempts - attempt + 1,
          baseDelay,
        );
      }
      return state;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableStopError(error)) {
        throw error;
      }
      await delay(baseDelay * attempt);
    }
  }

  throw lastError;
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
