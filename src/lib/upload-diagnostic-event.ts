export interface UploadDiagnosticEvent {
  version: 1;
  id: string;
  attemptId: string;
  sessionId: string;
  trackId: string;
  segmentId?: string;
  kind: "chunk" | "final" | "retry";
  stage: "presign" | "put" | "complete" | "backup" | "rebuild" | "recovery" | "materialize";
  outcome: "started" | "succeeded" | "failed" | "already_exists" | "retained" | "cleared" | "unknown";
  at: number;
  partNumber?: number;
  bytes?: number;
  elapsedMs?: number;
  httpStatus?: number;
  errorCategory?: "network" | "http" | "aborted" | "storage" | "unknown";
  trackStatus?: "recording" | "uploading" | "complete" | "failed";
  appVersion?: string;
  browser?: string;
}

export function isUploadDiagnosticId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

function boundedNumber(value: unknown, max: number, integer = false): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 &&
    value <= max && (!integer || Number.isInteger(value));
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

/** The same allowlist protects browser storage, exports, and server logs. */
export function sanitizeUploadDiagnosticEvent(value: unknown): UploadDiagnosticEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1 || !isUploadDiagnosticId(raw.id) ||
    !isUploadDiagnosticId(raw.attemptId) || !isUploadDiagnosticId(raw.sessionId) ||
    !isUploadDiagnosticId(raw.trackId) || !boundedNumber(raw.at, Number.MAX_SAFE_INTEGER, true) ||
    !oneOf(raw.kind, ["chunk", "final", "retry"]) ||
    !oneOf(raw.stage, ["presign", "put", "complete", "backup", "rebuild", "recovery", "materialize"]) ||
    !oneOf(raw.outcome, ["started", "succeeded", "failed", "already_exists", "retained", "cleared", "unknown"])
  ) return null;

  const event: UploadDiagnosticEvent = {
    version: 1, id: raw.id, attemptId: raw.attemptId, sessionId: raw.sessionId,
    trackId: raw.trackId, kind: raw.kind, stage: raw.stage, outcome: raw.outcome, at: raw.at,
  };
  if (isUploadDiagnosticId(raw.segmentId)) event.segmentId = raw.segmentId;
  if (boundedNumber(raw.partNumber, 1_000_000, true)) event.partNumber = raw.partNumber;
  if (boundedNumber(raw.bytes, Number.MAX_SAFE_INTEGER, true)) event.bytes = raw.bytes;
  if (boundedNumber(raw.elapsedMs, 7 * 24 * 60 * 60 * 1000)) event.elapsedMs = raw.elapsedMs;
  if (boundedNumber(raw.httpStatus, 599, true) && raw.httpStatus >= 100) event.httpStatus = raw.httpStatus;
  if (oneOf(raw.errorCategory, ["network", "http", "aborted", "storage", "unknown"])) event.errorCategory = raw.errorCategory;
  if (oneOf(raw.trackStatus, ["recording", "uploading", "complete", "failed"])) event.trackStatus = raw.trackStatus;
  if (typeof raw.appVersion === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(raw.appVersion)) event.appVersion = raw.appVersion;
  if (typeof raw.browser === "string" && /^(Chrome|Firefox|Safari|Edge|Opera|Other)(\/[0-9]{1,4}(\.[0-9]{1,4}){0,3})?$/.test(raw.browser)) event.browser = raw.browser;
  return event;
}
