import { beforeEach, describe, expect, it, vi } from "vitest";

type Track = {
  id: string;
  sessionId: string;
  s3Key: string;
  status: string;
  durationMs: number | null;
  partial?: boolean;
};

type TrackSegment = {
  id: string;
  trackId: string;
  segmentIndex: number;
  status: string;
  durationMs: number | null;
};

const mocks = vi.hoisted(() => ({
  tracks: new Map<string, Track>(),
  segments: new Map<string, TrackSegment>(),
  readObjectBytes: vi.fn<(key: string) => Promise<Uint8Array>>(),
  writeObjectBytes: vi.fn<(key: string, bytes: Uint8Array) => Promise<void>>(),
  remuxSegments: vi.fn<
    (input: { sourceKeys: string[]; outputKey: string }) => Promise<void>
  >(),
  trackSegmentRecordingExists: vi.fn<
    (sessionId: string, trackId: string, segmentId: string) => Promise<boolean>
  >(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    track: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
        const track = mocks.tracks.get(id);
        return track ? { ...track } : null;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: {
            id: string;
            status?: { not?: string };
            segments?: { none: { segmentIndex: { gt: number } } };
          };
          data: Partial<Track>;
        }) => {
          const existing = mocks.tracks.get(where.id);
          if (!existing) return { count: 0 };
          if (
            where.status?.not !== undefined &&
            existing.status === where.status.not
          ) {
            return { count: 0 };
          }
          const noneGt = where.segments?.none?.segmentIndex?.gt;
          if (noneGt !== undefined) {
            const hasNewer = Array.from(mocks.segments.values()).some(
              (segment) =>
                segment.trackId === where.id && segment.segmentIndex > noneGt,
            );
            if (hasNewer) return { count: 0 };
          }
          const updated = { ...existing, ...data };
          mocks.tracks.set(where.id, updated);
          return { count: 1 };
        },
      ),
    },
    trackSegment: {
      findMany: vi.fn(
        async ({
          where: { trackId },
          orderBy,
        }: {
          where: { trackId: string };
          orderBy?: { segmentIndex: "asc" | "desc" };
        }) => {
          const list = Array.from(mocks.segments.values())
            .filter((segment) => segment.trackId === trackId)
            .sort((a, b) => a.segmentIndex - b.segmentIndex)
            .map((segment) => ({ ...segment }));
          if (orderBy?.segmentIndex === "desc") list.reverse();
          return list;
        },
      ),
    },
  },
}));

vi.mock("@/lib/s3", () => ({
  getObjectBytes: mocks.readObjectBytes,
  putObjectBytes: mocks.writeObjectBytes,
  trackRecordingKey: (sessionId: string, trackId: string) =>
    `sessions/${sessionId}/tracks/${trackId}/recording.webm`,
  trackSegmentRecordingKey: (
    sessionId: string,
    trackId: string,
    segmentId: string,
  ) =>
    segmentId === trackId
      ? `sessions/${sessionId}/tracks/${trackId}/recording.webm`
      : `sessions/${sessionId}/tracks/${trackId}/segments/${segmentId}/recording.webm`,
  trackSegmentRecordingExists: mocks.trackSegmentRecordingExists,
}));

import { materializeTrack } from "@/lib/track-materialization";

function seedTrack(overrides: Partial<Track> = {}) {
  mocks.tracks.set("track-1", {
    id: "track-1",
    sessionId: "s1",
    s3Key: "sessions/s1/tracks/track-1/recording.webm",
    status: "uploading",
    durationMs: null,
    ...overrides,
  });
}

function seedSegment(overrides: Partial<TrackSegment> = {}) {
  const segment: TrackSegment = {
    id: overrides.id ?? "track-1",
    trackId: "track-1",
    segmentIndex: overrides.segmentIndex ?? 0,
    status: "complete",
    durationMs: 1000,
    ...overrides,
  };
  mocks.segments.set(segment.id, segment);
}

beforeEach(() => {
  mocks.tracks.clear();
  mocks.segments.clear();
  vi.clearAllMocks();
  mocks.readObjectBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.writeObjectBytes.mockResolvedValue(undefined);
  mocks.remuxSegments.mockResolvedValue(undefined);
  mocks.trackSegmentRecordingExists.mockResolvedValue(true);
});

describe("materializeTrack", () => {
  it("marks a complete one-segment default track complete without remuxing", async () => {
    seedTrack();
    seedSegment({ id: "track-1", durationMs: 12345 });

    const result = await materializeTrack("track-1", {
      readObjectBytes: mocks.readObjectBytes,
      writeObjectBytes: mocks.writeObjectBytes,
      remuxSegments: mocks.remuxSegments,
    });

    expect(result).toMatchObject({
      status: "complete",
      s3Key: "sessions/s1/tracks/track-1/recording.webm",
      segmentCount: 1,
    });
    expect(mocks.tracks.get("track-1")).toMatchObject({
      status: "complete",
      s3Key: "sessions/s1/tracks/track-1/recording.webm",
      durationMs: 12345,
    });
    expect(mocks.readObjectBytes).not.toHaveBeenCalled();
    expect(mocks.writeObjectBytes).not.toHaveBeenCalled();
    expect(mocks.remuxSegments).not.toHaveBeenCalled();
  });

  it("remuxes multiple completed segments into the logical track artifact", async () => {
    seedTrack();
    seedSegment({ id: "track-1", segmentIndex: 0, durationMs: 1000 });
    seedSegment({ id: "segment-2", segmentIndex: 1, durationMs: 5000 });

    const result = await materializeTrack("track-1", {
      readObjectBytes: mocks.readObjectBytes,
      writeObjectBytes: mocks.writeObjectBytes,
      remuxSegments: mocks.remuxSegments,
    });

    expect(mocks.remuxSegments).toHaveBeenCalledWith({
      sourceKeys: [
        "sessions/s1/tracks/track-1/recording.webm",
        "sessions/s1/tracks/track-1/segments/segment-2/recording.webm",
      ],
      outputKey: "sessions/s1/tracks/track-1/recording.webm",
    });
    expect(result).toMatchObject({
      status: "complete",
      s3Key: "sessions/s1/tracks/track-1/recording.webm",
      segmentCount: 2,
    });
    expect(mocks.tracks.get("track-1")).toMatchObject({
      status: "complete",
      s3Key: "sessions/s1/tracks/track-1/recording.webm",
      durationMs: 6000,
    });
  });

  it("does not mark the logical track complete when remuxing fails", async () => {
    seedTrack({ status: "uploading" });
    seedSegment({ id: "track-1", segmentIndex: 0, durationMs: 1000 });
    seedSegment({ id: "segment-2", segmentIndex: 1, durationMs: 5000 });
    mocks.remuxSegments.mockRejectedValueOnce(new Error("ffmpeg failed"));

    const result = await materializeTrack("track-1", {
      readObjectBytes: mocks.readObjectBytes,
      writeObjectBytes: mocks.writeObjectBytes,
      remuxSegments: mocks.remuxSegments,
    });

    expect(result).toMatchObject({
      status: "failed",
      s3Key: "sessions/s1/tracks/track-1/recording.webm",
      segmentCount: 2,
    });
    expect(mocks.tracks.get("track-1")).toMatchObject({
      status: "failed",
    });
    expect(mocks.tracks.get("track-1")?.status).not.toBe("complete");
  });

  it("skips missing completed segment artifacts for recovery materialization", async () => {
    seedTrack({ status: "uploading" });
    seedSegment({ id: "track-1", segmentIndex: 0, durationMs: 1000 });
    seedSegment({ id: "segment-2", segmentIndex: 1, durationMs: 5000 });
    mocks.trackSegmentRecordingExists.mockImplementation(
      async (_sessionId, _trackId, segmentId) => segmentId === "segment-2",
    );

    const result = await materializeTrack("track-1", {
      readObjectBytes: mocks.readObjectBytes,
      writeObjectBytes: mocks.writeObjectBytes,
      remuxSegments: mocks.remuxSegments,
      skipMissingSegments: true,
    });

    expect(result).toMatchObject({
      status: "complete",
      s3Key: "sessions/s1/tracks/track-1/recording.webm",
      segmentCount: 1,
    });
    expect(mocks.readObjectBytes).toHaveBeenCalledWith(
      "sessions/s1/tracks/track-1/segments/segment-2/recording.webm",
    );
    expect(mocks.writeObjectBytes).toHaveBeenCalledWith(
      "sessions/s1/tracks/track-1/recording.webm",
      new Uint8Array([1, 2, 3]),
    );
    expect(mocks.remuxSegments).not.toHaveBeenCalled();
    expect(mocks.tracks.get("track-1")).toMatchObject({
      status: "complete",
      s3Key: "sessions/s1/tracks/track-1/recording.webm",
      durationMs: 5000,
      partial: true,
    });
  });
});
