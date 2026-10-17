// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as presign } from "@/app/api/upload/presign/route";
import { POST as complete } from "@/app/api/upload/complete/route";

const state = vi.hoisted(() => ({
  track: { id: "track-1", sessionId: "session-1", status: "uploading", takeId: null },
  segment: { id: "segment-1", trackId: "track-1", status: "uploading", segmentIndex: 0 },
  presignError: null as Error | null,
  materializationStatus: "complete",
  authenticated: true,
}));
vi.mock("@/lib/db", () => ({ db: {
  track: { findUnique: async () => ({ ...state.track }) },
  trackSegment: {
    findUnique: async () => ({ ...state.segment }),
    findMany: async () => [{ ...state.segment }],
    update: async () => { state.segment.status = "complete"; },
  },
} }));
vi.mock("@/lib/auth", () => ({
  resolvePrincipal: async () => state.authenticated ? { kind: "host", participantId: "host" } : null,
  verifyRecordingUploadToken: async () => null,
}));
vi.mock("@/lib/s3", () => ({
  trackSegmentRecordingKey: () => "recording.webm",
  trackSegmentPartKey: () => "part.webm",
  getPresignedPutUrl: async () => {
    if (state.presignError) throw state.presignError;
    return "https://s3.example/?signed-secret=true";
  },
  deleteTrackSegmentChunks: async () => {},
}));
vi.mock("@/lib/track-materialization", () => ({
  materializeTrack: async () => {
    state.track.status = state.materializationStatus;
    return { trackId: "track-1", status: state.materializationStatus, s3Key: "private-key", segmentCount: 1, durationMs: null };
  },
}));
vi.mock("@/lib/recovery", () => ({ recoverInterruptedTrackSegments: async () => ({ recoveredSegmentIds: [], partial: false }) }));

function req(extra: Record<string, unknown> = {}) {
  return new NextRequest("https://cozytrack.example/api/upload/presign", {
    method: "POST", body: JSON.stringify({ sessionId: "session-1", trackId: "track-1", segmentId: "segment-1", partNumber: 9999, diagnosticAttemptId: "attempt-1", ...extra }),
  });
}
let logs: Record<string, unknown>[];
beforeEach(() => {
  state.track.status = "uploading";
  state.segment.status = "uploading";
  state.materializationStatus = "complete";
  state.presignError = null;
  state.authenticated = true;
  logs = [];
  vi.spyOn(console, "info").mockImplementation((prefix, data) => {
    if (prefix === "[UPLOAD]") logs.push(JSON.parse(data));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("upload server events", () => {
  it("correlates final presign without logging the signed URL", async () => {
    const response = await presign(req());
    expect(response.status).toBe(200);
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "server", stage: "presign", outcome: "started", attemptId: "attempt-1" }),
      expect.objectContaining({ source: "server", stage: "presign", outcome: "succeeded", httpStatus: 200, attemptId: "attempt-1", trackId: "track-1", segmentId: "segment-1" }),
    ]));
    expect(JSON.stringify(logs)).not.toContain("signed-secret");
  });

  it("logs a sanitized failure while preserving the existing 500 response", async () => {
    state.presignError = new Error("https://s3.example/?credentials=secret");
    const response = await presign(req());
    expect(response.status).toBe(500);
    expect(logs.at(-1)).toMatchObject({ source: "server", stage: "presign", outcome: "failed", httpStatus: 500, errorCategory: "unknown" });
    expect(JSON.stringify(logs)).not.toContain("credentials");
  });

  it("keeps a materialization failure visible even when completion returns HTTP 200", async () => {
    state.materializationStatus = "failed";
    const response = await complete(req());
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("failed");
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "materialize", outcome: "failed", materializationStatus: "failed", attemptId: "attempt-1" }),
      expect.objectContaining({ stage: "complete", outcome: "failed", httpStatus: 200, trackStatus: "failed", attemptId: "attempt-1" }),
    ]));
  });

  it("records already-complete requests without rematerializing or changing the response", async () => {
    state.track.status = "complete";
    state.segment.status = "complete";
    const response = await complete(req());
    expect(response.status).toBe(200);
    expect(logs.at(-1)).toMatchObject({ stage: "complete", outcome: "already_exists", trackStatus: "complete" });
  });

  it("does not generate server log spam for unauthenticated requests", async () => {
    state.authenticated = false;
    expect((await presign(req())).status).toBe(401);
    expect((await complete(req())).status).toBe(401);
    expect(logs).toEqual([]);
  });

  it("does not log every successful background chunk", async () => {
    expect((await presign(req({ partNumber: 17 }))).status).toBe(200);
    expect(logs).toEqual([]);
  });
});
