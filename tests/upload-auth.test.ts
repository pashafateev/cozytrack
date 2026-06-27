import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
  syncMarkerVersion?: string | null;
  syncMarkerOffsetMs?: number | null;
  syncMarkerDurationMs?: number | null;
};

const mocks = vi.hoisted(() => ({
  sessions: new Set<string>(),
  readySessions: new Set<string>(),
  tracks: new Map<string, Track>(),
  segments: new Map<string, TrackSegment>(),
  getPresignedPutUrl: vi.fn(async (key: string) => `https://s3.example/${key}`),
  deleteTrackSegmentChunks: vi.fn(async () => undefined),
  resolvePrincipal: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    session: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) =>
        mocks.sessions.has(id)
          ? { id, status: mocks.readySessions.has(id) ? "ready" : "recording" }
          : null,
      ),
    },
    recordingTake: {
      findFirst: vi.fn(async () => null),
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
          where,
          data,
        }: {
          where: {
            id: string;
            status?: { not?: string; in?: string[] };
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
          if (
            where.status?.in !== undefined &&
            !where.status.in.includes(existing.status)
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
          mocks.tracks.set(where.id, { ...existing, ...data });
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
  deleteTrackSegmentChunks: mocks.deleteTrackSegmentChunks,
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
import {
  SYNC_MARKER_DURATION_MS,
  SYNC_MARKER_OFFSET_MS,
  SYNC_MARKER_VERSION,
} from "@/lib/sync-marker";

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
  mocks.readySessions.clear();
  mocks.tracks.clear();
  mocks.segments.clear();
  mocks.sessions.add("s1");
  vi.clearAllMocks();
  mocks.resolvePrincipal.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("recording upload auth", () => {
  it("returns a track-scoped recording token when an authenticated recording starts", async () => {
    mocks.resolvePrincipal.mockResolvedValue({ kind: "host" });

    const res = await presignUpload(
      postJson(
        "/api/upload/presign",
        {
          sessionId: "s1",
          trackId: "t1",
          partNumber: 0,
          participantName: "Alice",
        },
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      key: string;
      url: string;
      recordingToken?: string;
    };
    expect(body.key).toBe("sessions/s1/tracks/t1/0.webm");
    expect(body.url).toBe("https://s3.example/sessions/s1/tracks/t1/0.webm");
    expect(body.recordingToken).toEqual(expect.any(String));
    expect(mocks.tracks.get("t1")?.participantName).toBe("Alice");
  });

  it("rejects starting an upload for an already-ready session", async () => {
    mocks.readySessions.add("s1");
    mocks.resolvePrincipal.mockResolvedValue({ kind: "host" });

    const res = await presignUpload(
      postJson(
        "/api/upload/presign",
        {
          sessionId: "s1",
          trackId: "t1",
          partNumber: 0,
          participantName: "Alice",
        },
      ),
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "Session is already finalized",
    });
    expect(mocks.tracks.has("t1")).toBe(false);
    expect(mocks.segments.has("t1")).toBe(false);
    expect(mocks.getPresignedPutUrl).not.toHaveBeenCalled();
  });

  it("stores sync marker metadata on the created track segment", async () => {
    mocks.resolvePrincipal.mockResolvedValue({ kind: "host" });

    const res = await presignUpload(
      postJson(
        "/api/upload/presign",
        {
          sessionId: "s1",
          trackId: "t1",
          segmentId: "seg-1",
          partNumber: 0,
          participantName: "Alice",
          syncMarker: {
            version: SYNC_MARKER_VERSION,
            offsetMs: SYNC_MARKER_OFFSET_MS,
            durationMs: SYNC_MARKER_DURATION_MS,
          },
        },
      ),
    );

    expect(res.status).toBe(200);
    expect(mocks.segments.get("seg-1")).toMatchObject({
      syncMarkerVersion: SYNC_MARKER_VERSION,
      syncMarkerOffsetMs: SYNC_MARKER_OFFSET_MS,
      syncMarkerDurationMs: SYNC_MARKER_DURATION_MS,
    });
  });

  it("rejects malformed sync marker metadata", async () => {
    mocks.resolvePrincipal.mockResolvedValue({ kind: "host" });

    const res = await presignUpload(
      postJson(
        "/api/upload/presign",
        {
          sessionId: "s1",
          trackId: "t1",
          partNumber: 0,
          participantName: "Alice",
          syncMarker: {
            version: "unknown-marker",
            offsetMs: SYNC_MARKER_OFFSET_MS,
            durationMs: SYNC_MARKER_DURATION_MS,
          },
        },
      ),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "syncMarker is invalid",
    });
    expect(mocks.segments.size).toBe(0);
  });

  it("stores the guest participant id from the authenticated principal", async () => {
    mocks.resolvePrincipal.mockResolvedValue({
      kind: "guest",
      sessionId: "s1",
      name: "Cookie Alice",
      participantId: "guest_alice",
    });

    const res = await presignUpload(
      postJson(
        "/api/upload/presign",
        {
          sessionId: "s1",
          trackId: "t1",
          partNumber: 0,
          participantName: "Renamed Alice",
          participantId: "spoofed-browser-id",
        },
      ),
    );

    expect(res.status).toBe(200);
    expect(mocks.tracks.get("t1")).toMatchObject({
      participantName: "Renamed Alice",
      participantId: "guest_alice",
    });
  });

  it("keeps presigning chunks with the recording token after cookies expire", async () => {
    mocks.resolvePrincipal.mockResolvedValueOnce({ kind: "host" });

    const start = await presignUpload(
      postJson(
        "/api/upload/presign",
        {
          sessionId: "s1",
          trackId: "t1",
          partNumber: 0,
          participantName: "Alice",
        },
      ),
    );
    const { recordingToken } = (await start.json()) as {
      recordingToken: string;
    };

    const res = await presignUpload(
      postJson(
        "/api/upload/presign",
        { sessionId: "s1", trackId: "t1", partNumber: 47 },
        { "x-cozytrack-recording-token": recordingToken },
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string; url: string };
    expect(body.key).toBe("sessions/s1/tracks/t1/47.webm");
  });

  it("keeps presigning the first recorded chunk with the recording token after cookies expire", async () => {
    mocks.resolvePrincipal.mockResolvedValueOnce({ kind: "host" });

    const start = await presignUpload(
      postJson(
        "/api/upload/presign",
        {
          sessionId: "s1",
          trackId: "t1",
          partNumber: 0,
          participantName: "Alice",
        },
      ),
    );
    const { recordingToken } = (await start.json()) as {
      recordingToken: string;
    };

    const res = await presignUpload(
      postJson(
        "/api/upload/presign",
        { sessionId: "s1", trackId: "t1", partNumber: 0 },
        { "x-cozytrack-recording-token": recordingToken },
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      key: string;
      recordingToken?: string;
      url: string;
    };
    expect(body.key).toBe("sessions/s1/tracks/t1/0.webm");
    expect(body.recordingToken).toBeUndefined();
  });

  it("keeps presigning the final recording upload with the recording token after cookies expire", async () => {
    mocks.resolvePrincipal.mockResolvedValueOnce({ kind: "host" });

    const start = await presignUpload(
      postJson(
        "/api/upload/presign",
        {
          sessionId: "s1",
          trackId: "t1",
          partNumber: 0,
          participantName: "Alice",
        },
      ),
    );
    const { recordingToken } = (await start.json()) as {
      recordingToken: string;
    };

    const res = await presignUpload(
      postJson(
        "/api/upload/presign",
        { sessionId: "s1", trackId: "t1", partNumber: 9999 },
        { "x-cozytrack-recording-token": recordingToken },
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string; url: string };
    expect(body.key).toBe("sessions/s1/tracks/t1/recording.webm");
  });

  it("rejects a recording token for a different track", async () => {
    const wrongTrackToken = await issueRecordingUploadToken("s1", "other-track");

    const res = await presignUpload(
      postJson(
        "/api/upload/presign",
        { sessionId: "s1", trackId: "t1", partNumber: 47 },
        { "x-cozytrack-recording-token": wrongTrackToken },
      ),
    );

    expect(res.status).toBe(401);
  });

  it("completes an upload with the recording token after cookies expire", async () => {
    mocks.tracks.set("t1", {
      id: "t1",
      sessionId: "s1",
      participantName: "Alice",
      s3Key: "sessions/s1/tracks/t1/recording.webm",
      status: "recording",
      durationMs: null,
    });
    mocks.segments.set("t1", {
      id: "t1",
      trackId: "t1",
      segmentIndex: 0,
      s3Prefix: "sessions/s1/tracks/t1/",
      status: "recording",
      durationMs: null,
    });
    const recordingToken = await issueRecordingUploadToken("s1", "t1");

    const res = await completeUpload(
      postJson(
        "/api/upload/complete",
        { sessionId: "s1", trackId: "t1", durationMs: 12345 },
        { "x-cozytrack-recording-token": recordingToken },
      ),
    );

    expect(res.status).toBe(200);
    expect(mocks.tracks.get("t1")).toMatchObject({
      status: "complete",
      durationMs: 12345,
    });
    expect(mocks.deleteTrackSegmentChunks).toHaveBeenCalledWith("s1", "t1", "t1");
  });

  it("rejects completing an upload for an already-ready session", async () => {
    mocks.readySessions.add("s1");
    mocks.tracks.set("t1", {
      id: "t1",
      sessionId: "s1",
      participantName: "Alice",
      s3Key: "sessions/s1/tracks/t1/recording.webm",
      status: "recording",
      durationMs: null,
    });
    mocks.segments.set("t1", {
      id: "t1",
      trackId: "t1",
      segmentIndex: 0,
      s3Prefix: "sessions/s1/tracks/t1/",
      status: "recording",
      durationMs: null,
    });
    const recordingToken = await issueRecordingUploadToken("s1", "t1");

    const res = await completeUpload(
      postJson(
        "/api/upload/complete",
        { sessionId: "s1", trackId: "t1", durationMs: 12345 },
        { "x-cozytrack-recording-token": recordingToken },
      ),
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "Session is already finalized",
    });
    expect(mocks.segments.get("t1")).toMatchObject({
      status: "recording",
      durationMs: null,
    });
    expect(mocks.tracks.get("t1")).toMatchObject({
      status: "recording",
      durationMs: null,
    });
    expect(mocks.deleteTrackSegmentChunks).not.toHaveBeenCalled();
  });

  it("forbids completing a track outside the requested session", async () => {
    mocks.tracks.set("t1", {
      id: "t1",
      sessionId: "other-session",
      participantName: "Alice",
      s3Key: "sessions/other-session/tracks/t1/recording.webm",
      status: "recording",
      durationMs: null,
    });
    mocks.segments.set("t1", {
      id: "t1",
      trackId: "t1",
      segmentIndex: 0,
      s3Prefix: "sessions/other-session/tracks/t1/",
      status: "recording",
      durationMs: null,
    });
    const recordingToken = await issueRecordingUploadToken("s1", "t1");

    const res = await completeUpload(
      postJson(
        "/api/upload/complete",
        { sessionId: "s1", trackId: "t1", durationMs: 12345 },
        { "x-cozytrack-recording-token": recordingToken },
      ),
    );

    expect(res.status).toBe(403);
    expect(mocks.tracks.get("t1")?.status).toBe("recording");
  });
});
