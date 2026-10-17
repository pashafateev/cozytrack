// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoverInterruptedTrackSegments, recoverStoppedTakeTracks, recoverTrack } from "@/lib/recovery";

const state = vi.hoisted(() => ({
  track: { id: "track-1", sessionId: "session-1", status: "recording", partial: false },
  segments: [] as { id: string; status: string; createdAt: Date; segmentIndex?: number }[],
  storageError: null as Error | null,
  sourceExists: false,
  parts: [] as { key: string; size: number; partNumber: number }[],
  writes: [] as Uint8Array[],
  putError: null as Error | null,
  materializationStatus: "failed",
  materializationError: null as Error | null,
}));
vi.mock("@/lib/db", () => ({ db: {
  track: {
    findUnique: async () => ({ ...state.track }),
    findMany: async () => [{ ...state.track, segments: state.segments }],
    update: async ({ data }: { data: object }) => Object.assign(state.track, data),
    updateMany: async ({ where, data }: { where: { status: string }; data: object }) => {
      if (where.status !== state.track.status) return { count: 0 };
      Object.assign(state.track, data);
      return { count: 1 };
    },
  },
  trackSegment: {
    findMany: async () => state.segments,
    updateMany: async ({ where, data }: { where: { id: string }; data: object }) => {
      const segment = state.segments.find((value) => value.id === where.id);
      if (!segment) return { count: 0 };
      Object.assign(segment, data);
      return { count: 1 };
    },
  },
} }));
vi.mock("@/lib/s3", () => ({
  trackRecordingExists: async () => { if (state.storageError) throw state.storageError; return false; },
  trackSegmentRecordingExists: async () => false,
  listTrackChunkParts: async () => [],
  listTrackSegmentChunkParts: async () => state.parts,
  trackSegmentSourceRecordingKey: () => "private-source-key",
  trackSegmentSourceRecordingExists: async () => state.sourceExists,
  getObjectBytes: async () => new Uint8Array([1, 2, 3]),
  putObjectBytes: async (_key: string, bytes: Uint8Array) => {
    if (state.putError) throw state.putError;
    state.writes.push(bytes);
  },
}));
vi.mock("@/lib/track-materialization", () => ({
  materializeTrack: async () => {
    if (state.materializationError) throw state.materializationError;
    return { status: state.materializationStatus };
  },
}));
let logs: Record<string, unknown>[];
beforeEach(() => {
  state.track = { id: "track-1", sessionId: "session-1", status: "recording", partial: false };
  state.segments = [];
  state.storageError = null;
  state.sourceExists = false;
  state.parts = [];
  state.writes = [];
  state.putError = null;
  state.materializationStatus = "failed";
  state.materializationError = null;
  logs = [];
  vi.spyOn(console, "info").mockImplementation((prefix, data) => {
    if (prefix === "[UPLOAD]") logs.push(JSON.parse(data));
  });
});
afterEach(() => vi.restoreAllMocks());

describe("server recovery diagnostics", () => {
  it("records the recovery result using one server-owned attempt id", async () => {
    const result = await recoverTrack("track-1");
    expect(result).toMatchObject({ outcome: "failed_no_chunks", status: "failed", chunkCount: 0 });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ source: "server", stage: "recovery", outcome: "started", sessionId: "session-1", trackId: "track-1" });
    expect(logs[1]).toMatchObject({ source: "server", stage: "recovery", outcome: "failed", recoveryOutcome: "failed_no_chunks", trackStatus: "failed", partial: false, attemptId: logs[0].attemptId });
    expect(logs[0].attemptId).toEqual(expect.any(String));
  });

  it("identifies the segment and failed materialization without changing the recovery result", async () => {
    state.segments = [{ id: "segment-1", status: "complete", createdAt: new Date(0) }];
    const result = await recoverTrack("track-1");
    expect(result.outcome).toBe("failed_materialization");
    expect(logs.at(-1)).toMatchObject({ segmentId: "segment-1", recoveryOutcome: "failed_materialization", outcome: "failed" });
  });

  it("logs failures without copying exception details and rethrows the same failure", async () => {
    const error = new Error("https://s3.example/?token=private");
    state.storageError = error;
    await expect(recoverTrack("track-1")).rejects.toBe(error);
    expect(logs.at(-1)).toMatchObject({ stage: "recovery", outcome: "failed", errorCategory: "unknown" });
    expect(JSON.stringify(logs)).not.toContain("private");
  });

  it("keeps recovery outcomes intact if the logger throws", async () => {
    vi.mocked(console.info).mockImplementation(() => { throw new Error("logger unavailable"); });
    expect((await recoverTrack("track-1")).outcome).toBe("failed_no_chunks");
  });
});

function segment(id: string, segmentIndex: number, status = "recording") {
  return { id, segmentIndex, status, createdAt: new Date(0) };
}

describe("interrupted segment recovery diagnostics", () => {
  it("correlates each recovered source with its segment using one operation attempt", async () => {
    state.segments = [segment("segment-1", 0), segment("segment-2", 1)];
    state.parts = [{ key: "chunk-0", size: 3, partNumber: 0 }];
    const result = await recoverInterruptedTrackSegments("track-1", 2);
    expect(result).toEqual({ recoveredSegmentIds: ["segment-1", "segment-2"], partial: false });
    expect(state.writes).toEqual([new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])]);
    expect(logs).toHaveLength(4);
    expect(new Set(logs.map((value) => value.attemptId)).size).toBe(1);
    for (const segmentId of ["segment-1", "segment-2"]) {
      expect(logs).toContainEqual(expect.objectContaining({ source: "server", stage: "recovery", outcome: "started", segmentId }));
      expect(logs).toContainEqual(expect.objectContaining({ source: "server", stage: "recovery", outcome: "succeeded", recoveryOutcome: "recovered_from_chunks", segmentId, bytes: 3, partial: false }));
    }
  });

  it("records a retained oversized source while preserving the partial result", async () => {
    state.segments = [segment("segment-1", 0)];
    state.parts = [{ key: "chunk-0", size: 6, partNumber: 0 }];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await recoverInterruptedTrackSegments("track-1", 1, { maxStitchBytes: 3 })).toEqual({ recoveredSegmentIds: [], partial: true });
    expect(state.writes).toEqual([]);
    expect(logs.at(-1)).toMatchObject({ stage: "recovery", outcome: "retained", recoveryOutcome: "failed_too_large", segmentId: "segment-1", bytes: 6, partial: true });
  });

  it("logs a source write failure and rethrows the same error without secrets", async () => {
    state.segments = [segment("segment-1", 0)];
    state.parts = [{ key: "chunk-0", size: 3, partNumber: 0 }];
    state.putError = new Error("https://example.invalid/?token=private");
    await expect(recoverInterruptedTrackSegments("track-1", 1)).rejects.toBe(state.putError);
    expect(logs.at(-1)).toMatchObject({ stage: "recovery", outcome: "failed", segmentId: "segment-1", errorCategory: "unknown" });
    expect(JSON.stringify(logs)).not.toContain("private");
  });

  it("keeps interrupted recovery successful when logging throws", async () => {
    state.segments = [segment("segment-1", 0)];
    state.sourceExists = true;
    vi.mocked(console.info).mockImplementation(() => { throw new Error("logger unavailable"); });
    expect(await recoverInterruptedTrackSegments("track-1", 1)).toEqual({ recoveredSegmentIds: ["segment-1"], partial: false });
  });
});

describe("stopped take materialization diagnostics", () => {
  beforeEach(() => {
    state.segments = [segment("segment-1", 0, "complete")];
    state.track.status = "uploading";
  });

  it("records stopped-take materialization success using the existing session context", async () => {
    state.materializationStatus = "complete";
    expect(await recoverStoppedTakeTracks("take-1")).toEqual(["track-1"]);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ stage: "materialize", outcome: "started", sessionId: "session-1", trackId: "track-1", segmentId: "segment-1" });
    expect(logs[1]).toMatchObject({ stage: "materialize", outcome: "succeeded", materializationStatus: "complete", attemptId: logs[0].attemptId });
  });

  it("retains the materialization status and original failure when the track stays pending", async () => {
    state.materializationStatus = "pending";
    await expect(recoverStoppedTakeTracks("take-1")).rejects.toThrow("Stopped take take-1 failed to materialize track track-1: pending");
    expect(logs.at(-1)).toMatchObject({ stage: "materialize", outcome: "failed", materializationStatus: "pending", segmentId: "segment-1" });
  });

  it("does not report an already-partial track as whole", async () => {
    state.track.partial = true;
    state.materializationStatus = "complete";
    expect(await recoverStoppedTakeTracks("take-1")).toEqual(["track-1"]);
    expect(logs.at(-1)).toMatchObject({ materializationStatus: "complete", partial: true });
  });

  it("rethrows an original materialization exception without logging it", async () => {
    state.materializationError = new Error("https://example.invalid/?token=private");
    await expect(recoverStoppedTakeTracks("take-1")).rejects.toBe(state.materializationError);
    expect(logs.at(-1)).toMatchObject({ stage: "materialize", outcome: "failed", errorCategory: "unknown" });
    expect(JSON.stringify(logs)).not.toContain("private");
  });

  it("keeps stopped-take success when logging throws", async () => {
    state.materializationStatus = "complete";
    vi.mocked(console.info).mockImplementation(() => { throw new Error("logger unavailable"); });
    expect(await recoverStoppedTakeTracks("take-1")).toEqual(["track-1"]);
  });
});
