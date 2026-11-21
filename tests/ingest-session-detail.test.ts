import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Prisma,
  RecordingTake,
  Session,
  Track,
  TrackSegment,
} from "@prisma/client";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  resolvePrincipal: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { session: { findUnique: mocks.findUnique } },
}));

vi.mock("@/lib/auth", () => ({
  resolvePrincipal: mocks.resolvePrincipal,
}));

import { GET as ingestDetail } from "@/app/api/ingest/sessions/[id]/route";
import { GET as browserDetail } from "@/app/api/sessions/[id]/route";

type StoredSession = Session & {
  recordingTakes: RecordingTake[];
  tracks: (Track & { segments: TrackSegment[] })[];
};

const browserQuery = {
  where: { id: "session-1" },
  include: { tracks: { orderBy: { createdAt: "asc" } } },
} satisfies Prisma.SessionFindUniqueArgs;

const ingestQuery = {
  where: { id: "session-1" },
  include: {
    tracks: {
      orderBy: { createdAt: "asc" },
      include: { segments: { select: { status: true } } },
    },
    recordingTakes: {
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      select: { id: true, startedAt: true, stoppedAt: true, status: true },
    },
  },
} satisfies Prisma.SessionFindUniqueArgs;

function track(overrides: Partial<Track> = {}): Track {
  const id = overrides.id ?? "track-reconnect";
  return {
    id,
    sessionId: "session-1",
    takeId: "take-a",
    participantName: "Host",
    participantId: "host-1",
    s3Key: `sessions/session-1/tracks/${id}/recording.webm`,
    durationMs: 120_000,
    format: "webm",
    status: "complete",
    s3PurgedAt: null,
    deviceLabel: "External microphone",
    deviceId: "device-1",
    isBuiltInMic: false,
    sessionStartedAt: new Date("2026-05-01T10:00:00.000Z"),
    partial: false,
    createdAt: new Date("2026-05-01T10:00:02.000Z"),
    updatedAt: new Date("2026-05-01T10:02:00.000Z"),
    ...overrides,
  };
}

function take(
  id: string,
  startedAt: string,
  overrides: Partial<RecordingTake> = {},
): RecordingTake {
  return {
    id,
    sessionId: "session-1",
    startedAt: new Date(startedAt),
    stoppedAt: new Date(new Date(startedAt).getTime() + 120_000),
    status: "stopped",
    createdAt: new Date("2026-05-01T09:00:00.000Z"),
    updatedAt: new Date("2026-05-01T10:02:00.000Z"),
    ...overrides,
  };
}

function segments(trackId: string, statuses: string[]): TrackSegment[] {
  return statuses.map((status, segmentIndex) => ({
    id: `${trackId}-segment-${segmentIndex}`,
    trackId,
    segmentIndex,
    s3Prefix: `sessions/session-1/tracks/${trackId}/segments/${segmentIndex}`,
    status,
    durationMs: status === "complete" ? 60_000 : null,
    startedAt: new Date("2026-05-01T10:00:00.000Z"),
    completedAt: status === "complete"
      ? new Date("2026-05-01T10:01:00.000Z")
      : null,
    createdAt: new Date("2026-05-01T10:00:00.000Z"),
    updatedAt: new Date("2026-05-01T10:01:00.000Z"),
  }));
}

function fixture(): StoredSession {
  return {
    id: "session-1",
    name: "Multipart episode",
    // Take lifecycle must not be inferred from the session's status.
    status: "recording",
    finalizedAt: null,
    createdAt: new Date("2026-05-01T09:00:00.000Z"),
    updatedAt: new Date("2026-05-01T10:10:00.000Z"),
    // Deliberately unordered, including a start-time tie and an empty active take.
    recordingTakes: [
      take("take-z", "2026-05-01T10:05:00.000Z"),
      take("take-b", "2026-05-01T10:00:00.000Z"),
      take("take-a", "2026-05-01T10:00:00.000Z"),
      take("take-active", "2026-05-01T10:10:00.000Z", {
        status: "recording",
        stoppedAt: null,
      }),
    ],
    tracks: [
      {
        ...track(),
        segments: segments("track-reconnect", ["complete", "complete"]),
      },
      {
        ...track({
          id: "track-legacy",
          takeId: null,
          participantId: null,
          participantName: "Legacy guest",
          durationMs: null,
          deviceLabel: null,
          deviceId: null,
          sessionStartedAt: null,
          createdAt: new Date("2026-05-01T09:59:00.000Z"),
        }),
        segments: [],
      },
      {
        ...track({
          id: "track-partial",
          takeId: "take-z",
          participantId: "guest-1",
          participantName: "Guest",
          partial: true,
          s3PurgedAt: new Date("2026-05-02T10:00:00.000Z"),
          createdAt: new Date("2026-05-01T10:05:01.000Z"),
        }),
        segments: segments("track-partial", [
          "complete", "recording", "uploading", "failed", "future-status",
        ]),
      },
    ],
  };
}

function selectScalars(row: object, select?: object | null) {
  if (!select) return { ...row };
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => Reflect.get(select, key) === true),
  );
}

function orderRows<T extends { id: string; createdAt: Date; startedAt?: Date }>(
  rows: T[],
  orderBy: unknown,
): T[] {
  const orders = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  return [...rows].sort((left, right) => {
    for (const order of orders) {
      for (const [key, direction] of Object.entries(order)) {
        const a = Reflect.get(left, key);
        const b = Reflect.get(right, key);
        const difference = a instanceof Date && b instanceof Date
          ? a.getTime() - b.getTime()
          : String(a).localeCompare(String(b));
        if (difference) return direction === "desc" ? -difference : difference;
      }
    }
    return 0;
  });
}

let session: StoredSession;

// Exercise the real helper and routes, not a pre-serialized response. This
// query-aware DB double only returns requested relations/fields and applies the
// requested ordering. Exact query assertions below also pin scalar preservation
// and prevent accidentally fetching segment timestamps or storage metadata.
function querySession({ where, include }: Prisma.SessionFindUniqueArgs) {
  if (where.id !== session.id) return null;
  const { tracks, recordingTakes, ...scalars } = session;
  const result: Record<string, unknown> = { ...scalars };
  if (include?.tracks) {
    const args = include.tracks === true ? {} : include.tracks;
    result.tracks = orderRows(tracks, args.orderBy).map(
      ({ segments: rows, ...trackScalars }) => {
        const result: Record<string, unknown> =
          selectScalars(trackScalars, args.select);
        if (args.include?.segments) {
          const segmentArgs = args.include.segments === true
            ? {}
            : args.include.segments;
          result.segments = rows.map((row) =>
            selectScalars(row, segmentArgs.select),
          );
        }
        return result;
      },
    );
  }
  if (include?.recordingTakes) {
    const args = include.recordingTakes === true ? {} : include.recordingTakes;
    result.recordingTakes = orderRows(recordingTakes, args.orderBy)
      .map((row) => selectScalars(row, args.select));
  }
  return result;
}

function detailRequest(
  route: typeof ingestDetail,
  path = "/api/ingest/sessions",
  id = "session-1",
) {
  return route(new NextRequest(`http://localhost${path}/${id}`), {
    params: Promise.resolve({ id }),
  });
}

function json(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

beforeEach(() => {
  vi.resetAllMocks();
  session = fixture();
  mocks.findUnique.mockImplementation(async (args: Prisma.SessionFindUniqueArgs) =>
    querySession(args),
  );
  mocks.resolvePrincipal.mockResolvedValue({ kind: "host" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/ingest/sessions/[id]", () => {
  it("queries ordered take lifecycle and segment statuses without narrowing track scalars", async () => {
    const response = await detailRequest(ingestDetail);

    expect(response.status).toBe(200);
    expect(mocks.findUnique).toHaveBeenCalledExactlyOnceWith(ingestQuery);
  });

  it("serializes takes by (startedAt, id), including empty and active takes", async () => {
    const response = await detailRequest(ingestDetail);
    const body = await response.json();

    expect(body.recordingTakes).toEqual([
      {
        id: "take-a",
        startedAt: "2026-05-01T10:00:00.000Z",
        stoppedAt: "2026-05-01T10:02:00.000Z",
        status: "stopped",
      },
      {
        id: "take-b",
        startedAt: "2026-05-01T10:00:00.000Z",
        stoppedAt: "2026-05-01T10:02:00.000Z",
        status: "stopped",
      },
      {
        id: "take-z",
        startedAt: "2026-05-01T10:05:00.000Z",
        stoppedAt: "2026-05-01T10:07:00.000Z",
        status: "stopped",
      },
      {
        id: "take-active",
        startedAt: "2026-05-01T10:10:00.000Z",
        stoppedAt: null,
        status: "recording",
      },
    ]);
    expect(body.status).toBe("recording");
  });

  it("preserves the full existing session/track response with only additive metadata", async () => {
    const response = await detailRequest(ingestDetail);
    const { recordingTakes, tracks, ...scalars } = session;

    expect(await response.json()).toEqual(json({
      ...scalars,
      recordingTakes: orderRows(recordingTakes, ingestQuery.include.recordingTakes.orderBy)
        .map(({ id, startedAt, stoppedAt, status }) => ({
          id, startedAt, stoppedAt, status,
        })),
      tracks: orderRows(tracks, browserQuery.include.tracks.orderBy)
        .map(({ segments, ...track }) => ({
          ...track,
          segmentCount: segments.length,
          incompleteSegmentCount: segments.filter((s) => s.status !== "complete").length,
        })),
    }));
  });

  it("exposes a complete reconnect track even when partial is false", async () => {
    const response = await detailRequest(ingestDetail);
    const body = await response.json();

    expect(body.tracks.find((t: Track) => t.id === "track-reconnect")).toMatchObject({
      takeId: "take-a",
      participantId: "host-1",
      partial: false,
      status: "complete",
      segmentCount: 2,
      incompleteSegmentCount: 0,
    });
  });

  it("counts every known segment and every non-complete status, not just failed ones", async () => {
    const response = await detailRequest(ingestDetail);
    const body = await response.json();

    expect(body.tracks.find((t: Track) => t.id === "track-partial")).toMatchObject({
      partial: true,
      segmentCount: 5,
      incompleteSegmentCount: 4,
    });
  });

  it("returns zero counts for legacy tracks without inventing a segment or take", async () => {
    session.recordingTakes = [];
    session.tracks = session.tracks.filter((track) => track.takeId === null);
    const response = await detailRequest(ingestDetail);
    const body = await response.json();

    expect(body.recordingTakes).toEqual([]);
    expect(body.tracks.find((t: Track) => t.id === "track-legacy")).toMatchObject({
      takeId: null,
      participantId: null,
      partial: false,
      segmentCount: 0,
      incompleteSegmentCount: 0,
    });
  });

  it("returns empty collections for a session without tracks or takes", async () => {
    session.tracks = [];
    session.recordingTakes = [];
    const response = await detailRequest(ingestDetail);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(json(session));
  });
});

describe("browser session-detail compatibility", () => {
  it("keeps the existing query and exact response without take or segment metadata", async () => {
    const response = await detailRequest(browserDetail, "/api/sessions");
    const { recordingTakes: _takes, tracks, ...scalars } = session;

    expect(response.status).toBe(200);
    expect(mocks.findUnique).toHaveBeenCalledExactlyOnceWith(browserQuery);
    expect(await response.json()).toEqual(json({
      ...scalars,
      tracks: orderRows(tracks, browserQuery.include.tracks.orderBy)
        .map(({ segments: _segments, ...track }) => track),
    }));
  });

  it("still rejects unauthenticated browser requests before querying the session", async () => {
    mocks.resolvePrincipal.mockResolvedValue(null);
    const response = await detailRequest(browserDetail, "/api/sessions");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("still rejects guests from another session before querying the session", async () => {
    mocks.resolvePrincipal.mockResolvedValue({ kind: "guest", sessionId: "other" });
    const response = await detailRequest(browserDetail, "/api/sessions");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });
});

describe.each([
  { name: "ingest", route: ingestDetail, path: "/api/ingest/sessions" },
  { name: "browser", route: browserDetail, path: "/api/sessions" },
])("$name session-detail errors", ({ route, path }) => {
  it("returns the existing 404 response when the session is missing", async () => {
    const response = await detailRequest(route, path, "missing-session");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
    expect(mocks.findUnique).toHaveBeenCalledOnce();
    expect(mocks.findUnique.mock.calls[0][0].where).toEqual({ id: "missing-session" });
  });

  it("returns the existing 500 response without exposing database errors", async () => {
    const error = new Error("database unavailable");
    mocks.findUnique.mockRejectedValueOnce(error);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await detailRequest(route, path);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to get session" });
    expect(log).toHaveBeenCalledWith("Failed to get session:", error);
  });
});
