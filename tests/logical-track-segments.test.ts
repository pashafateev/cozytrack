import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";

type Principal =
  | { kind: "host"; participantId?: string }
  | { kind: "guest"; sessionId: string; name: string; participantId: string };

type RecordingTake = {
  id: string;
  sessionId: string;
  startedAt: Date;
  stoppedAt: Date | null;
};

type Track = {
  id: string;
  sessionId: string;
  takeId?: string | null;
  participantName: string;
  participantId?: string | null;
  s3Key: string;
  status: string;
  durationMs: number | null;
};

type TrackSegment = {
  id: string;
  trackId: string;
  segmentIndex: number;
  s3Prefix: string;
  status: string;
  durationMs: number | null;
  completedAt?: Date | null;
};

const mocks = vi.hoisted(() => ({
  sessions: new Set<string>(),
  recordingTakes: new Map<string, RecordingTake>(),
  tracks: new Map<string, Track>(),
  segments: new Map<string, TrackSegment>(),
  getPresignedPutUrl: vi.fn(async (key: string) => `https://s3.example/${key}`),
  deleteTrackChunks: vi.fn(async () => undefined),
  deleteTrackSegmentChunks: vi.fn(async () => undefined),
  resolvePrincipal: vi.fn<() => Promise<Principal | null>>(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    session: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) =>
        mocks.sessions.has(id) ? { id } : null,
      ),
    },
    recordingTake: {
      findFirst: vi.fn(
        async ({
          where: { sessionId, stoppedAt },
        }: {
          where: { sessionId: string; stoppedAt: null };
        }) => {
          return (
            Array.from(mocks.recordingTakes.values()).find(
              (take) =>
                take.sessionId === sessionId && take.stoppedAt === stoppedAt,
            ) ?? null
          );
        },
      ),
    },
    track: {
      findUnique: vi.fn(
        async ({ where: { id } }: { where: { id: string } }) => {
          const track = mocks.tracks.get(id);
          return track ? { ...track } : null;
        },
      ),
      findFirst: vi.fn(
        async ({
          where: { sessionId, takeId, participantId },
        }: {
          where: {
            sessionId: string;
            takeId?: string | null;
            participantId?: string | null;
          };
        }) => {
          return (
            Array.from(mocks.tracks.values()).find(
              (track) =>
                track.sessionId === sessionId &&
                track.takeId === takeId &&
                track.participantId === participantId,
            ) ?? null
          );
        },
      ),
      create: vi.fn(async ({ data }: { data: Track }) => {
        const track = { ...data, status: "recording", durationMs: null };
        mocks.tracks.set(track.id, track);
        return { ...track };
      }),
      update: vi.fn(
        async ({
          where: { id },
          data,
        }: {
          where: { id: string };
          data: Partial<Track>;
        }) => {
          const existing = mocks.tracks.get(id);
          if (!existing) throw new Error("track not found");
          const updated = { ...existing, ...data };
          mocks.tracks.set(id, updated);
          return { ...updated };
        },
      ),
      updateMany: vi.fn(
        async ({
          where: { id, status },
          data,
        }: {
          where: { id: string; status?: { not: string } };
          data: Partial<Track>;
        }) => {
          const existing = mocks.tracks.get(id);
          if (!existing) return { count: 0 };
          if (status?.not !== undefined && existing.status === status.not) {
            return { count: 0 };
          }
          mocks.tracks.set(id, { ...existing, ...data });
          return { count: 1 };
        },
      ),
    },
    trackSegment: {
      count: vi.fn(
        async ({ where: { trackId } }: { where: { trackId: string } }) =>
          Array.from(mocks.segments.values()).filter(
            (segment) => segment.trackId === trackId,
          ).length,
      ),
      findUnique: vi.fn(
        async ({ where: { id } }: { where: { id: string } }) => {
          const segment = mocks.segments.get(id);
          return segment ? { ...segment } : null;
        },
      ),
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
      create: vi.fn(async ({ data }: { data: TrackSegment }) => {
        const segment = { ...data, status: "recording", durationMs: null };
        mocks.segments.set(segment.id, segment);
        return { ...segment };
      }),
      update: vi.fn(
        async ({
          where: { id },
          data,
        }: {
          where: { id: string };
          data: Partial<TrackSegment>;
        }) => {
          const existing = mocks.segments.get(id);
          if (!existing) throw new Error("segment not found");
          const updated = { ...existing, ...data };
          mocks.segments.set(id, updated);
          return { ...updated };
        },
      ),
    },
  },
}));

vi.mock("@/lib/s3", () => ({
  getPresignedPutUrl: mocks.getPresignedPutUrl,
  deleteTrackChunks: mocks.deleteTrackChunks,
  deleteTrackSegmentChunks: mocks.deleteTrackSegmentChunks,
  trackPartKey: (sessionId: string, trackId: string, partNumber: number) =>
    `sessions/${sessionId}/tracks/${trackId}/${partNumber}.webm`,
  trackRecordingKey: (sessionId: string, trackId: string) =>
    `sessions/${sessionId}/tracks/${trackId}/recording.webm`,
  trackSegmentPrefix: (sessionId: string, trackId: string, segmentId: string) =>
    segmentId === trackId
      ? `sessions/${sessionId}/tracks/${trackId}/`
      : `sessions/${sessionId}/tracks/${trackId}/segments/${segmentId}/`,
  trackSegmentPartKey: (
    sessionId: string,
    trackId: string,
    segmentId: string,
    partNumber: number,
  ) =>
    segmentId === trackId
      ? `sessions/${sessionId}/tracks/${trackId}/${partNumber}.webm`
      : `sessions/${sessionId}/tracks/${trackId}/segments/${segmentId}/${partNumber}.webm`,
  trackSegmentRecordingKey: (
    sessionId: string,
    trackId: string,
    segmentId: string,
  ) =>
    segmentId === trackId
      ? `sessions/${sessionId}/tracks/${trackId}/recording.webm`
      : `sessions/${sessionId}/tracks/${trackId}/segments/${segmentId}/recording.webm`,
}));

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>(
    "@/lib/auth",
  );
  return {
    ...actual,
    resolvePrincipal: mocks.resolvePrincipal,
  };
});

import { NextRequest } from "next/server";
import { POST as presignUpload } from "@/app/api/upload/presign/route";
import { POST as completeUpload } from "@/app/api/upload/complete/route";
import { issueRecordingUploadToken } from "@/lib/auth";
import { db } from "@/lib/db";

function postJson(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`http://localhost:3001${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "test-secret-for-recording-upload-token-123456");
  mocks.sessions.clear();
  mocks.recordingTakes.clear();
  mocks.tracks.clear();
  mocks.segments.clear();
  mocks.sessions.add("s1");
  vi.clearAllMocks();
  mocks.resolvePrincipal.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("logical track segments", () => {
  it("creates the first physical segment under the new logical track", async () => {
    mocks.recordingTakes.set("take-1", {
      id: "take-1",
      sessionId: "s1",
      startedAt: new Date("2026-06-11T00:00:00.000Z"),
      stoppedAt: null,
    });
    mocks.resolvePrincipal.mockResolvedValue({
      kind: "guest",
      sessionId: "s1",
      name: "Cookie Alice",
      participantId: "guest_alice",
    });

    const res = await presignUpload(
      postJson("/api/upload/presign", {
        sessionId: "s1",
        trackId: "track-1",
        partNumber: 0,
        participantName: "Renamed Alice",
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      key: string;
      segmentId: string;
      trackId: string;
    };
    expect(body.trackId).toBe("track-1");
    expect(body.segmentId).toBe("track-1");
    expect(body.key).toBe("sessions/s1/tracks/track-1/0.webm");
    expect(mocks.tracks.get("track-1")).toMatchObject({
      takeId: "take-1",
      participantId: "guest_alice",
    });
    expect(mocks.segments.get("track-1")).toMatchObject({
      trackId: "track-1",
      segmentIndex: 0,
      s3Prefix: "sessions/s1/tracks/track-1/",
      status: "recording",
    });
  });

  it("reuses one logical track per participant and take for a later segment", async () => {
    mocks.recordingTakes.set("take-1", {
      id: "take-1",
      sessionId: "s1",
      startedAt: new Date("2026-06-11T00:00:00.000Z"),
      stoppedAt: null,
    });
    mocks.tracks.set("logical-track", {
      id: "logical-track",
      sessionId: "s1",
      takeId: "take-1",
      participantName: "Alice",
      participantId: "guest_alice",
      s3Key: "sessions/s1/tracks/logical-track/recording.webm",
      status: "recording",
      durationMs: null,
    });
    mocks.segments.set("logical-track", {
      id: "logical-track",
      trackId: "logical-track",
      segmentIndex: 0,
      s3Prefix: "sessions/s1/tracks/logical-track/",
      status: "recording",
      durationMs: null,
    });
    mocks.resolvePrincipal.mockResolvedValue({
      kind: "guest",
      sessionId: "s1",
      name: "Cookie Alice",
      participantId: "guest_alice",
    });

    const res = await presignUpload(
      postJson("/api/upload/presign", {
        sessionId: "s1",
        trackId: "new-browser-segment",
        partNumber: 0,
        participantName: "Alice Again",
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      key: string;
      segmentId: string;
      trackId: string;
    };
    expect(body.trackId).toBe("logical-track");
    expect(body.segmentId).toBe("new-browser-segment");
    expect(body.key).toBe(
      "sessions/s1/tracks/logical-track/segments/new-browser-segment/0.webm",
    );
    expect(mocks.tracks.has("new-browser-segment")).toBe(false);
    expect(mocks.segments.get("new-browser-segment")).toMatchObject({
      trackId: "logical-track",
      segmentIndex: 1,
      s3Prefix:
        "sessions/s1/tracks/logical-track/segments/new-browser-segment/",
      status: "recording",
    });
  });

  it("returns a complete track to recording when a new segment starts", async () => {
    mocks.recordingTakes.set("take-1", {
      id: "take-1",
      sessionId: "s1",
      startedAt: new Date("2026-06-11T00:00:00.000Z"),
      stoppedAt: null,
    });
    mocks.tracks.set("logical-track", {
      id: "logical-track",
      sessionId: "s1",
      takeId: "take-1",
      participantName: "Alice",
      participantId: "guest_alice",
      s3Key: "sessions/s1/tracks/logical-track/recording.webm",
      status: "complete",
      durationMs: 1000,
    });
    mocks.segments.set("logical-track", {
      id: "logical-track",
      trackId: "logical-track",
      segmentIndex: 0,
      s3Prefix: "sessions/s1/tracks/logical-track/",
      status: "complete",
      durationMs: 1000,
    });
    mocks.resolvePrincipal.mockResolvedValue({
      kind: "guest",
      sessionId: "s1",
      name: "Cookie Alice",
      participantId: "guest_alice",
    });

    const res = await presignUpload(
      postJson("/api/upload/presign", {
        sessionId: "s1",
        trackId: "new-browser-segment",
        partNumber: 0,
        participantName: "Alice",
      }),
    );

    expect(res.status).toBe(200);
    // While the re-record is in flight the track must not look finished —
    // otherwise finalize/downloads serve the previous recording as if final.
    expect(mocks.tracks.get("logical-track")?.status).toBe("recording");
  });

  it("marks the addressed segment complete when the upload completes", async () => {
    mocks.tracks.set("track-1", {
      id: "track-1",
      sessionId: "s1",
      participantName: "Alice",
      participantId: "guest_alice",
      s3Key: "sessions/s1/tracks/track-1/recording.webm",
      status: "recording",
      durationMs: null,
    });
    mocks.segments.set("track-1", {
      id: "track-1",
      trackId: "track-1",
      segmentIndex: 0,
      s3Prefix: "sessions/s1/tracks/track-1/",
      status: "recording",
      durationMs: null,
    });
    const recordingToken = await issueRecordingUploadToken("s1", "track-1");

    const res = await completeUpload(
      postJson(
        "/api/upload/complete",
        { sessionId: "s1", trackId: "track-1", segmentId: "track-1", durationMs: 12345 },
        { "x-cozytrack-recording-token": recordingToken },
      ),
    );

    expect(res.status).toBe(200);
    expect(mocks.segments.get("track-1")).toMatchObject({
      status: "complete",
      durationMs: 12345,
    });
    expect(mocks.tracks.get("track-1")).toMatchObject({
      status: "complete",
      durationMs: 12345,
    });
    expect(mocks.deleteTrackSegmentChunks).toHaveBeenCalledWith(
      "s1",
      "track-1",
      "track-1",
    );
  });

  it("promotes the logical track to the latest segment once all segments complete", async () => {
    mocks.tracks.set("logical-track", {
      id: "logical-track",
      sessionId: "s1",
      participantName: "Alice",
      participantId: "guest_alice",
      s3Key: "sessions/s1/tracks/logical-track/recording.webm",
      status: "complete",
      durationMs: 1000,
    });
    mocks.segments.set("logical-track", {
      id: "logical-track",
      trackId: "logical-track",
      segmentIndex: 0,
      s3Prefix: "sessions/s1/tracks/logical-track/",
      status: "complete",
      durationMs: 1000,
    });
    mocks.segments.set("browser-seg-2", {
      id: "browser-seg-2",
      trackId: "logical-track",
      segmentIndex: 1,
      s3Prefix: "sessions/s1/tracks/logical-track/segments/browser-seg-2/",
      status: "recording",
      durationMs: null,
    });
    const recordingToken = await issueRecordingUploadToken("s1", "logical-track");

    const res = await completeUpload(
      postJson(
        "/api/upload/complete",
        {
          sessionId: "s1",
          trackId: "logical-track",
          segmentId: "browser-seg-2",
          durationMs: 5000,
        },
        { "x-cozytrack-recording-token": recordingToken },
      ),
    );

    expect(res.status).toBe(200);
    expect(mocks.segments.get("browser-seg-2")).toMatchObject({
      status: "complete",
      durationMs: 5000,
    });
    // The logical track must not be demoted back to uploading — with every
    // segment complete it stays finalizable and serves the newest audio.
    expect(mocks.tracks.get("logical-track")).toMatchObject({
      status: "complete",
      s3Key:
        "sessions/s1/tracks/logical-track/segments/browser-seg-2/recording.webm",
      durationMs: 5000,
    });
    expect(mocks.deleteTrackSegmentChunks).toHaveBeenCalledWith(
      "s1",
      "logical-track",
      "browser-seg-2",
    );
  });

  it("keeps the logical track pending while a newer segment is still recording", async () => {
    mocks.tracks.set("logical-track", {
      id: "logical-track",
      sessionId: "s1",
      participantName: "Alice",
      participantId: "guest_alice",
      s3Key: "sessions/s1/tracks/logical-track/recording.webm",
      status: "recording",
      durationMs: null,
    });
    mocks.segments.set("logical-track", {
      id: "logical-track",
      trackId: "logical-track",
      segmentIndex: 0,
      s3Prefix: "sessions/s1/tracks/logical-track/",
      status: "recording",
      durationMs: null,
    });
    mocks.segments.set("browser-seg-2", {
      id: "browser-seg-2",
      trackId: "logical-track",
      segmentIndex: 1,
      s3Prefix: "sessions/s1/tracks/logical-track/segments/browser-seg-2/",
      status: "recording",
      durationMs: null,
    });
    const recordingToken = await issueRecordingUploadToken("s1", "logical-track");

    // The default segment's late completion lands while the newer re-record
    // attempt is still in flight — the track must not look finished yet.
    const defaultSegmentRes = await completeUpload(
      postJson(
        "/api/upload/complete",
        {
          sessionId: "s1",
          trackId: "logical-track",
          segmentId: "logical-track",
          durationMs: 1000,
        },
        { "x-cozytrack-recording-token": recordingToken },
      ),
    );

    expect(defaultSegmentRes.status).toBe(200);
    expect(mocks.tracks.get("logical-track")?.status).toBe("uploading");

    const secondSegmentRes = await completeUpload(
      postJson(
        "/api/upload/complete",
        {
          sessionId: "s1",
          trackId: "logical-track",
          segmentId: "browser-seg-2",
          durationMs: 5000,
        },
        { "x-cozytrack-recording-token": recordingToken },
      ),
    );

    expect(secondSegmentRes.status).toBe(200);
    expect(mocks.tracks.get("logical-track")).toMatchObject({
      status: "complete",
      s3Key:
        "sessions/s1/tracks/logical-track/segments/browser-seg-2/recording.webm",
      durationMs: 5000,
    });
  });

  it("retries segment creation when a concurrent start claims the index", async () => {
    mocks.recordingTakes.set("take-1", {
      id: "take-1",
      sessionId: "s1",
      startedAt: new Date("2026-06-11T00:00:00.000Z"),
      stoppedAt: null,
    });
    mocks.tracks.set("logical-track", {
      id: "logical-track",
      sessionId: "s1",
      takeId: "take-1",
      participantName: "Alice",
      participantId: "guest_alice",
      s3Key: "sessions/s1/tracks/logical-track/recording.webm",
      status: "recording",
      durationMs: null,
    });
    mocks.segments.set("logical-track", {
      id: "logical-track",
      trackId: "logical-track",
      segmentIndex: 0,
      s3Prefix: "sessions/s1/tracks/logical-track/",
      status: "recording",
      durationMs: null,
    });
    mocks.resolvePrincipal.mockResolvedValue({
      kind: "guest",
      sessionId: "s1",
      name: "Cookie Alice",
      participantId: "guest_alice",
    });
    // A concurrent start for the same participant/take grabbed the counted
    // segmentIndex first — the unique [trackId, segmentIndex] constraint
    // rejects the first create attempt.
    (db.trackSegment.create as unknown as Mock).mockImplementationOnce(
      async () => {
        const err = new Error(
          "Unique constraint failed on the fields: (`trackId`,`segmentIndex`)",
        ) as Error & { code: string };
        err.code = "P2002";
        throw err;
      },
    );

    const res = await presignUpload(
      postJson("/api/upload/presign", {
        sessionId: "s1",
        trackId: "new-browser-segment",
        partNumber: 0,
        participantName: "Alice",
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { segmentId: string; trackId: string };
    expect(body.trackId).toBe("logical-track");
    expect(body.segmentId).toBe("new-browser-segment");
    expect(mocks.segments.get("new-browser-segment")).toMatchObject({
      trackId: "logical-track",
      status: "recording",
    });
  });

  it("does not demote a complete track when an older segment completes late", async () => {
    // Race outcome state: the newest segment's completion already promoted
    // the track while an older segment's completion was still in flight.
    mocks.tracks.set("logical-track", {
      id: "logical-track",
      sessionId: "s1",
      participantName: "Alice",
      participantId: "guest_alice",
      s3Key:
        "sessions/s1/tracks/logical-track/segments/browser-seg-2/recording.webm",
      status: "complete",
      durationMs: 5000,
    });
    mocks.segments.set("logical-track", {
      id: "logical-track",
      trackId: "logical-track",
      segmentIndex: 0,
      s3Prefix: "sessions/s1/tracks/logical-track/",
      status: "recording",
      durationMs: null,
    });
    mocks.segments.set("browser-seg-2", {
      id: "browser-seg-2",
      trackId: "logical-track",
      segmentIndex: 1,
      s3Prefix: "sessions/s1/tracks/logical-track/segments/browser-seg-2/",
      status: "recording",
      durationMs: null,
    });
    const recordingToken = await issueRecordingUploadToken("s1", "logical-track");

    const res = await completeUpload(
      postJson(
        "/api/upload/complete",
        {
          sessionId: "s1",
          trackId: "logical-track",
          segmentId: "logical-track",
          durationMs: 1000,
        },
        { "x-cozytrack-recording-token": recordingToken },
      ),
    );

    expect(res.status).toBe(200);
    // The older completion must not clobber the already-promoted track back
    // to uploading — that would block finalize with every segment complete.
    expect(mocks.tracks.get("logical-track")).toMatchObject({
      status: "complete",
      s3Key:
        "sessions/s1/tracks/logical-track/segments/browser-seg-2/recording.webm",
    });
  });

  it("completes the track from the newest segment even when an older segment was abandoned", async () => {
    mocks.tracks.set("logical-track", {
      id: "logical-track",
      sessionId: "s1",
      participantName: "Alice",
      participantId: "guest_alice",
      s3Key: "sessions/s1/tracks/logical-track/recording.webm",
      status: "recording",
      durationMs: null,
    });
    // The first attempt died without ever completing — its row stays
    // "recording" forever. The re-record supersedes it.
    mocks.segments.set("logical-track", {
      id: "logical-track",
      trackId: "logical-track",
      segmentIndex: 0,
      s3Prefix: "sessions/s1/tracks/logical-track/",
      status: "recording",
      durationMs: null,
    });
    mocks.segments.set("browser-seg-2", {
      id: "browser-seg-2",
      trackId: "logical-track",
      segmentIndex: 1,
      s3Prefix: "sessions/s1/tracks/logical-track/segments/browser-seg-2/",
      status: "recording",
      durationMs: null,
    });
    const recordingToken = await issueRecordingUploadToken("s1", "logical-track");

    const res = await completeUpload(
      postJson(
        "/api/upload/complete",
        {
          sessionId: "s1",
          trackId: "logical-track",
          segmentId: "browser-seg-2",
          durationMs: 5000,
        },
        { "x-cozytrack-recording-token": recordingToken },
      ),
    );

    expect(res.status).toBe(200);
    // The newest attempt is done; the dead older segment must not hold the
    // track in uploading and block finalize.
    expect(mocks.tracks.get("logical-track")).toMatchObject({
      status: "complete",
      s3Key:
        "sessions/s1/tracks/logical-track/segments/browser-seg-2/recording.webm",
      durationMs: 5000,
    });
  });
});
