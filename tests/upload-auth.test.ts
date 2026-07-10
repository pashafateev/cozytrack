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
};

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, string>(),
  tracks: new Map<string, Track>(),
  segments: new Map<string, TrackSegment>(),
  getPresignedPutUrl: vi.fn(async (key: string) => `https://s3.example/${key}`),
  deleteTrackSegmentChunks: vi.fn(async () => undefined),
  resolvePrincipal: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const client = {
    // withSessionLock runs its callback inside db.$transaction and issues a raw
    // advisory-lock query; the mock just needs these to exist and pass through.
    $executeRaw: async () => 0,
    session: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) =>
        mocks.sessions.has(id) ? { id, status: mocks.sessions.get(id) } : null,
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
  };
  return {
    db: {
      ...client,
      $transaction: async (fn: (tx: typeof client) => unknown) => fn(client),
    },
  };
});

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
  mocks.tracks.clear();
  mocks.segments.clear();
  mocks.sessions.set("s1", "recording");
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
    mocks.getPresignedPutUrl.mockClear();

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
    expect(mocks.getPresignedPutUrl).toHaveBeenCalledWith(
      "sessions/s1/tracks/t1/recording.webm",
      { createOnly: true },
    );
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

    const retry = await completeUpload(
      postJson(
        "/api/upload/complete",
        { sessionId: "s1", trackId: "t1", durationMs: 12345 },
        { "x-cozytrack-recording-token": recordingToken },
      ),
    );
    expect(retry.status).toBe(200);
    expect(mocks.deleteTrackSegmentChunks).toHaveBeenCalledTimes(1);
  });

  it("allows authorized chunk presign and completion for a track created before finalization", async () => {
    mocks.resolvePrincipal.mockResolvedValueOnce({ kind: "host" });
    const start = await presignUpload(
      postJson("/api/upload/presign", {
        sessionId: "s1",
        trackId: "t1",
        partNumber: 0,
        participantName: "Alice",
      }),
    );
    expect(start.status).toBe(200);
    const { recordingToken } = (await start.json()) as {
      recordingToken: string;
    };

    mocks.sessions.set("s1", "ready");

    const chunk = await presignUpload(
      postJson(
        "/api/upload/presign",
        { sessionId: "s1", trackId: "t1", partNumber: 1 },
        { "x-cozytrack-recording-token": recordingToken },
      ),
    );
    expect(chunk.status).toBe(200);

    const complete = await completeUpload(
      postJson(
        "/api/upload/complete",
        { sessionId: "s1", trackId: "t1", durationMs: 12345 },
        { "x-cozytrack-recording-token": recordingToken },
      ),
    );
    expect(complete.status).toBe(200);
    expect(mocks.tracks.get("t1")).toMatchObject({
      status: "complete",
      durationMs: 12345,
    });
  });

  it("does not issue a writable URL for a complete track after finalization", async () => {
    mocks.sessions.set("s1", "ready");
    mocks.tracks.set("t1", {
      id: "t1",
      sessionId: "s1",
      participantName: "Alice",
      s3Key: "sessions/s1/tracks/t1/recording.webm",
      status: "complete",
      durationMs: 12345,
    });
    mocks.segments.set("t1", {
      id: "t1",
      trackId: "t1",
      segmentIndex: 0,
      s3Prefix: "sessions/s1/tracks/t1/",
      status: "complete",
      durationMs: 12345,
    });
    const recordingToken = await issueRecordingUploadToken("s1", "t1");
    mocks.getPresignedPutUrl.mockClear();

    const res = await presignUpload(
      postJson(
        "/api/upload/presign",
        { sessionId: "s1", trackId: "t1", partNumber: 9999 },
        { "x-cozytrack-recording-token": recordingToken },
      ),
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("already complete"),
    });
    expect(mocks.getPresignedPutUrl).not.toHaveBeenCalled();
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

describe("host-owned local track slots", () => {
  it("creates two local-slot tracks with stable synthetic participant ids", async () => {
    mocks.resolvePrincipal.mockResolvedValue({ kind: "host", participantId: "host" });

    const ch1 = await presignUpload(
      postJson("/api/upload/presign", {
        sessionId: "s1",
        trackId: "local-1",
        partNumber: 0,
        participantName: "Local Ch 1",
        localTrackSlotId: "host-local-ch-1",
      }),
    );
    const ch2 = await presignUpload(
      postJson("/api/upload/presign", {
        sessionId: "s1",
        trackId: "local-2",
        partNumber: 0,
        participantName: "Local Ch 2",
        localTrackSlotId: "host-local-ch-2",
      }),
    );

    expect(ch1.status).toBe(200);
    expect(ch2.status).toBe(200);

    // Two distinct logical tracks, each with a stable slot-derived participant
    // id — not the raw "host" principal id, so both channels coexist under the
    // Track [takeId, participantId] uniqueness constraint.
    expect(mocks.tracks.get("local-1")).toMatchObject({
      participantName: "Local Ch 1",
      participantId: "host-local-ch-1",
    });
    expect(mocks.tracks.get("local-2")).toMatchObject({
      participantName: "Local Ch 2",
      participantId: "host-local-ch-2",
    });
  });

  it("keeps local slot tracks separate from a normal guest track", async () => {
    mocks.resolvePrincipal.mockResolvedValueOnce({ kind: "host", participantId: "host" });
    await presignUpload(
      postJson("/api/upload/presign", {
        sessionId: "s1",
        trackId: "local-1",
        partNumber: 0,
        participantName: "Local Ch 1",
        localTrackSlotId: "host-local-ch-1",
      }),
    );

    mocks.resolvePrincipal.mockResolvedValueOnce({
      kind: "guest",
      sessionId: "s1",
      name: "Remote Bob",
      participantId: "guest_bob",
    });
    const guest = await presignUpload(
      postJson("/api/upload/presign", {
        sessionId: "s1",
        trackId: "guest-track",
        partNumber: 0,
        participantName: "Remote Bob",
      }),
    );

    expect(guest.status).toBe(200);
    expect(mocks.tracks.get("local-1")?.participantId).toBe("host-local-ch-1");
    expect(mocks.tracks.get("guest-track")?.participantId).toBe("guest_bob");
  });

  it("rejects a guest attempting to claim a local track slot", async () => {
    mocks.resolvePrincipal.mockResolvedValue({
      kind: "guest",
      sessionId: "s1",
      name: "Sneaky Guest",
      participantId: "guest_sneaky",
    });

    const res = await presignUpload(
      postJson("/api/upload/presign", {
        sessionId: "s1",
        trackId: "local-1",
        partNumber: 0,
        participantName: "Local Ch 1",
        localTrackSlotId: "host-local-ch-1",
      }),
    );

    expect(res.status).toBe(403);
    expect(mocks.tracks.get("local-1")).toBeUndefined();
  });

  it("rejects an unknown local track slot id", async () => {
    mocks.resolvePrincipal.mockResolvedValue({ kind: "host", participantId: "host" });

    const res = await presignUpload(
      postJson("/api/upload/presign", {
        sessionId: "s1",
        trackId: "local-9",
        partNumber: 0,
        participantName: "Local Ch 9",
        localTrackSlotId: "host-local-ch-9",
      }),
    );

    expect(res.status).toBe(400);
    expect(mocks.tracks.get("local-9")).toBeUndefined();
  });
});
