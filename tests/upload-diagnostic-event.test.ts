import { describe, expect, it } from "vitest";
import { sanitizeUploadDiagnosticEvent } from "@/lib/upload-diagnostic-event";

const event = {
  version: 1, id: "event-1", attemptId: "attempt-1", sessionId: "session-1",
  trackId: "track-1", segmentId: "segment-1", kind: "final", stage: "put",
  outcome: "failed", at: 1_800_000_000_000,
};

describe("upload diagnostic event privacy boundary", () => {
  it("keeps only allowlisted data and strips raw errors, URLs, identity and source", () => {
    expect(sanitizeUploadDiagnosticEvent({
      ...event, bytes: 100, elapsedMs: 20.5, httpStatus: 403,
      errorCategory: "http", trackStatus: "uploading", appVersion: "v1.2.3-a",
      browser: "Chrome/130", source: "server", receivedAt: 42,
      participantName: "Alice", url: "https://s3.example/?secret=token",
      message: "Bearer secret", headers: { Authorization: "secret" },
    })).toEqual({
      ...event, bytes: 100, elapsedMs: 20.5, httpStatus: 403,
      errorCategory: "http", trackStatus: "uploading", appVersion: "v1.2.3-a",
      browser: "Chrome/130",
    });
  });

  it.each([
    { id: "user@example.com" }, { attemptId: "x".repeat(81) },
    { sessionId: "../session" }, { trackId: "" }, { version: 2 },
    { kind: "secret" }, { stage: "https://secret" }, { outcome: "secret" },
    { at: -1 }, { at: Infinity }, { at: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects an invalid required field: %j", (invalid) => {
    expect(sanitizeUploadDiagnosticEvent({ ...event, ...invalid })).toBeNull();
  });

  it("omits invalid optional fields instead of logging their contents", () => {
    expect(sanitizeUploadDiagnosticEvent({
      ...event, segmentId: "../secret", partNumber: -1, bytes: Infinity,
      elapsedMs: -1, httpStatus: 900, errorCategory: "secret",
      trackStatus: "participant name", appVersion: "https://secret",
      browser: "Mozilla/5.0 secret user agent",
    })).toEqual(Object.fromEntries(Object.entries(event).filter(([key]) => key !== "segmentId")));
  });
});
