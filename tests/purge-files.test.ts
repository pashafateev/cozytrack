import { describe, it, expect, beforeEach, vi } from "vitest";

type Track = {
  id: string;
  s3PurgedAt: Date | null;
};

type Session = {
  id: string;
  name: string;
  status: string;
  tracks: Track[];
};

const mocks = vi.hoisted(() => ({
  sessionStore: new Map<string, Session>(),
  deleteSessionObjects: vi.fn(),
}));

function cloneSession(session: Session): Session {
  return {
    ...session,
    tracks: session.tracks.map((track) => ({ ...track })),
  };
}

vi.mock("@/lib/db", () => ({
  db: {
    session: {
      findUnique: vi.fn(
        async ({ where: { id } }: { where: { id: string } }) => {
          const session = mocks.sessionStore.get(id);
          return session ? cloneSession(session) : null;
        },
      ),
    },
    track: {
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { sessionId: string; s3PurgedAt?: null };
          data: { s3PurgedAt: Date };
        }) => {
          const session = mocks.sessionStore.get(where.sessionId);
          if (!session) {
            return { count: 0 };
          }

          let count = 0;
          for (const track of session.tracks) {
            if (where.s3PurgedAt === null && track.s3PurgedAt !== null) {
              continue;
            }

            track.s3PurgedAt = data.s3PurgedAt;
            count += 1;
          }

          return { count };
        },
      ),
    },
  },
}));

vi.mock("@/lib/s3", () => ({
  deleteSessionObjects: mocks.deleteSessionObjects,
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/ingest/sessions/[id]/purge-files/route";

function req(sessionId: string): NextRequest {
  return new NextRequest(
    `http://localhost:3001/api/ingest/sessions/${sessionId}/purge-files`,
    { method: "POST" },
  );
}

async function updateManyMock() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: {
      track: {
        updateMany: ReturnType<typeof vi.fn>;
      };
    };
  };
  return db.track.updateMany;
}

beforeEach(() => {
  mocks.sessionStore.clear();
  vi.clearAllMocks();
  mocks.deleteSessionObjects.mockResolvedValue(0);
});

describe("POST /api/ingest/sessions/[id]/purge-files", () => {
  it("returns 404 when the session does not exist", async () => {
    const res = await POST(req("missing"), {
      params: Promise.resolve({ id: "missing" }),
    });

    expect(res.status).toBe(404);
    expect(mocks.deleteSessionObjects).not.toHaveBeenCalled();
  });

  it("returns 409 when the session is not ready", async () => {
    mocks.sessionStore.set("s1", {
      id: "s1",
      name: "demo",
      status: "recording",
      tracks: [{ id: "t1", s3PurgedAt: null }],
    });

    const res = await POST(req("s1"), {
      params: Promise.resolve({ id: "s1" }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Session is not ready");
    expect(mocks.deleteSessionObjects).not.toHaveBeenCalled();
  });

  it("deletes session objects and marks all tracks as purged", async () => {
    mocks.deleteSessionObjects.mockResolvedValueOnce(4);
    mocks.sessionStore.set("s2", {
      id: "s2",
      name: "demo",
      status: "ready",
      tracks: [
        { id: "t1", s3PurgedAt: null },
        { id: "t2", s3PurgedAt: null },
      ],
    });

    const before = Date.now();
    const res = await POST(req("s2"), {
      params: Promise.resolve({ id: "s2" }),
    });

    expect(res.status).toBe(200);
    expect(mocks.deleteSessionObjects).toHaveBeenCalledWith("s2");

    const body = (await res.json()) as {
      sessionId: string;
      deletedObjects: number;
      purgedTracks: number;
      s3PurgedAt: string;
    };
    expect(body.sessionId).toBe("s2");
    expect(body.deletedObjects).toBe(4);
    expect(body.purgedTracks).toBe(2);
    expect(new Date(body.s3PurgedAt).getTime()).toBeGreaterThanOrEqual(before);

    const purgedAtValues = mocks.sessionStore
      .get("s2")!
      .tracks.map((track) => track.s3PurgedAt?.toISOString());
    expect(purgedAtValues[0]).toBe(body.s3PurgedAt);
    expect(purgedAtValues[1]).toBe(body.s3PurgedAt);
  });

  it("is idempotent when all tracks are already purged", async () => {
    const s3PurgedAt = new Date("2026-05-10T12:00:00.000Z");
    mocks.sessionStore.set("s3", {
      id: "s3",
      name: "demo",
      status: "ready",
      tracks: [
        { id: "t1", s3PurgedAt },
        { id: "t2", s3PurgedAt },
      ],
    });

    const res = await POST(req("s3"), {
      params: Promise.resolve({ id: "s3" }),
    });

    expect(res.status).toBe(200);
    expect(mocks.deleteSessionObjects).not.toHaveBeenCalled();
    expect(await updateManyMock()).not.toHaveBeenCalled();

    const body = (await res.json()) as {
      sessionId: string;
      deletedObjects: number;
      purgedTracks: number;
      s3PurgedAt: string;
    };
    expect(body).toEqual({
      sessionId: "s3",
      deletedObjects: 0,
      purgedTracks: 0,
      s3PurgedAt: s3PurgedAt.toISOString(),
    });
  });

  it("preserves existing purge timestamps when only some tracks are unpurged", async () => {
    mocks.deleteSessionObjects.mockResolvedValueOnce(1);
    const existingPurgedAt = new Date("2026-05-10T12:00:00.000Z");
    mocks.sessionStore.set("s5", {
      id: "s5",
      name: "demo",
      status: "ready",
      tracks: [
        { id: "t1", s3PurgedAt: existingPurgedAt },
        { id: "t2", s3PurgedAt: null },
      ],
    });

    const res = await POST(req("s5"), {
      params: Promise.resolve({ id: "s5" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deletedObjects: number;
      purgedTracks: number;
      s3PurgedAt: string;
    };
    expect(body.deletedObjects).toBe(1);
    expect(body.purgedTracks).toBe(1);

    const tracks = mocks.sessionStore.get("s5")!.tracks;
    expect(tracks[0].s3PurgedAt?.toISOString()).toBe(
      existingPurgedAt.toISOString(),
    );
    expect(tracks[1].s3PurgedAt?.toISOString()).toBe(body.s3PurgedAt);
    expect(await updateManyMock()).toHaveBeenCalledWith({
      where: { sessionId: "s5", s3PurgedAt: null },
      data: { s3PurgedAt: expect.any(Date) },
    });
  });

  it("does not write purge timestamps when S3 deletion fails", async () => {
    mocks.deleteSessionObjects.mockRejectedValueOnce(new Error("S3 failed"));
    mocks.sessionStore.set("s4", {
      id: "s4",
      name: "demo",
      status: "ready",
      tracks: [{ id: "t1", s3PurgedAt: null }],
    });

    const res = await POST(req("s4"), {
      params: Promise.resolve({ id: "s4" }),
    });

    expect(res.status).toBe(500);
    expect(mocks.sessionStore.get("s4")!.tracks[0].s3PurgedAt).toBeNull();
    expect(await updateManyMock()).not.toHaveBeenCalled();
  });
});
