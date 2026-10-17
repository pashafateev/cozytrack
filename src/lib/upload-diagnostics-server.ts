import { randomUUID } from "node:crypto";
import { isUploadDiagnosticId, sanitizeUploadDiagnosticEvent, type UploadDiagnosticEvent } from "@/lib/upload-diagnostic-event";

type ServerDetails = {
  materializationStatus?: "complete" | "pending" | "failed" | "superseded";
  recoveryOutcome?: "already_complete" | "recovered_from_recording" | "recovered_from_chunks" | "recovered_partial" | "skipped_active" | "failed_no_chunks" | "failed_too_large" | "failed_materialization";
  partial?: boolean;
};

/** Logging is best effort and must never change an upload or recovery result. */
export function logUploadDiagnosticEvent(value: unknown, source: "browser" | "server"): void {
  try {
    const event = sanitizeUploadDiagnosticEvent(value);
    if (!event) return;
    const details: ServerDetails = {};
    if (source === "server") {
      const raw = value as Record<string, unknown>;
      if (["complete", "pending", "failed", "superseded"].includes(raw.materializationStatus as string)) details.materializationStatus = raw.materializationStatus as ServerDetails["materializationStatus"];
      if (["already_complete", "recovered_from_recording", "recovered_from_chunks", "recovered_partial", "skipped_active", "failed_no_chunks", "failed_too_large", "failed_materialization"].includes(raw.recoveryOutcome as string)) details.recoveryOutcome = raw.recoveryOutcome as ServerDetails["recoveryOutcome"];
      if (typeof raw.partial === "boolean") details.partial = raw.partial;
    }
    console.info("[UPLOAD]", JSON.stringify({ ...event, ...details, source, receivedAt: Date.now() }));
  } catch {
    // A logger failure is not a recording failure.
  }
}

export function logServerUploadDiagnostic(
  event: Omit<UploadDiagnosticEvent, "version" | "id" | "at"> & ServerDetails,
): void {
  try {
    logUploadDiagnosticEvent({ ...event, version: 1, id: randomUUID(), at: Date.now() }, "server");
  } catch {
    // Keep diagnostics outside the success/failure path.
  }
}

/** Per-request context, activated only after an upload credential is verified. */
export class UploadRouteDiagnostics {
  private context?: Omit<UploadDiagnosticEvent, "version" | "id" | "at" | "outcome">;
  private authorized = false;
  private startedAt = Date.now();
  trackStatus?: string;
  outcome?: UploadDiagnosticEvent["outcome"];

  constructor(private readonly stage: "presign" | "complete") {}

  setScope(body: { sessionId?: unknown; trackId?: unknown; segmentId?: unknown; partNumber?: unknown; diagnosticAttemptId?: unknown }): void {
    if (!isUploadDiagnosticId(body.sessionId) || !isUploadDiagnosticId(body.trackId)) return;
    this.context = {
      sessionId: body.sessionId,
      trackId: body.trackId,
      segmentId: isUploadDiagnosticId(body.segmentId) ? body.segmentId : body.trackId,
      attemptId: isUploadDiagnosticId(body.diagnosticAttemptId) ? body.diagnosticAttemptId : randomUUID(),
      kind: this.stage === "complete" || body.partNumber === 9999 ? "final" : "chunk",
      stage: this.stage,
      ...(typeof body.partNumber === "number" ? { partNumber: body.partNumber } : {}),
    };
  }

  updateScope(trackId: string, segmentId: string): void {
    if (this.context) this.context = { ...this.context, trackId, segmentId };
  }

  start(): void {
    this.authorized = true;
    if (this.context && (this.context.kind !== "chunk" || this.context.partNumber === 0)) {
      logServerUploadDiagnostic({ ...this.context, outcome: "started" });
    }
  }

  materialized(status: ServerDetails["materializationStatus"]): void {
    if (!this.authorized || !this.context) return;
    logServerUploadDiagnostic({
      ...this.context, stage: "materialize", materializationStatus: status,
      outcome: status === "complete" ? "succeeded" : status === "failed" ? "failed" : "unknown",
      elapsedMs: Date.now() - this.startedAt,
    });
  }

  finish(httpStatus: number): void {
    if (!this.authorized || !this.context) return;
    if (httpStatus < 400 && this.context.kind === "chunk" && this.context.partNumber !== 0) return;
    const outcome = httpStatus >= 400 ? "failed" : this.outcome ?? (
      this.stage !== "complete" || this.trackStatus === "complete" ? "succeeded" :
        this.trackStatus === "failed" ? "failed" : "unknown"
    );
    logServerUploadDiagnostic({
      ...this.context, outcome, httpStatus, elapsedMs: Date.now() - this.startedAt,
      trackStatus: this.trackStatus as UploadDiagnosticEvent["trackStatus"],
      ...(httpStatus >= 400 ? { errorCategory: httpStatus >= 500 ? "unknown" as const : "http" as const } : {}),
    });
  }
}
