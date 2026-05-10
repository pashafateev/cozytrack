import { describe, it, expect, beforeEach, vi } from "vitest";

type Track = { id: string; participantName: string; status: string };
type Session = {
  id: string;
  name: string;
  status: string;
  finalizedAt: Date | null;
  tracks: Track[];
};

const sessionStore = new Map<string, Session>();

function tracksFor(sessionId: string): Track[] {
  return sessionStore.get(sessionId)?.tracks ?? [];
}

vi.mock("@/lib/recovery", () => ({
  // Recovery is exercised in tests/recovery.test.ts. In finalize tests we
  // assert the orchestration around it; the recovery itself is a no-op.
  recoverTrack: vi.fn(async (trackId: string) => ({ trackId })),
}));

vi.mock("@/lib/db", () => ({
  db: {
    session: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
        const s = sessionStore.get(id);
        return s ? structuredClone(s) : null;
      }),
      update: vi.fn(
        async ({
          where: { id },
          data,
        }: {
          where: { id: string };
          data: Partial<Session>;
        }) => {
          const existing = sessionStore.get(id);
          if (!existing) throw new Error("not found");
          const updated = { ...existing, ...data };
          sessionStore.set(id, updated);
          return structuredClone(updated);
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status?: string };
          data: Partial<Session>;
        }) => {
          const existing = sessionStore.get(where.id);
          if (!existing) return { count: 0 };
          if (where.status !== undefined && existing.status !== where.status) {
            return { count: 0 };
          }
          sessionStore.set(where.id, { ...existing, ...data });
          return { count: 1 };
        },
      ),
    },
    track: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { id: { in: string[] } };
        }) => {
          const ids = new Set(where.id.in);
          const all: Track[] = [];
          for (const s of sessionStore.values()) {
            for (const t of s.tracks) {
              if (ids.has(t.id)) all.push(structuredClone(t));
            }
          }
          return all;
        },
      ),
    },
  },
}));

import { POST } from "@/app/api/sessions/[id]/finalize/route";
import { NextRequest } from "next/server";

function req(): NextRequest {
  return new NextRequest("http://localhost:3001/api/sessions/x/finalize", {
    method: "POST",
  });
}

beforeEach(() => {
  sessionStore.clear();
  vi.clearAllMocks();
});

describe("POST /api/sessions/[id]/finalize", () => {
  it("returns 404 when the session does not exist", async () => {
    const res = await POST(req(), { params: Promise.resolve({ id: "missing" }) });
    expect(res.status).toBe(404);
  });

  it("returns 409 with pending tracks when any track is not complete", async () => {
    sessionStore.set("s1", {
      id: "s1",
      name: "demo",
      status: "recording",
      finalizedAt: null,
      tracks: [
        { id: "t1", participantName: "Alice", status: "complete" },
        { id: "t2", participantName: "Bob", status: "uploading" },
      ],
    });

    const res = await POST(req(), { params: Promise.resolve({ id: "s1" }) });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { pending: Array<{ trackId: string; participantName: string; status: string }> };
    expect(body.pending).toEqual([
      { trackId: "t2", participantName: "Bob", status: "uploading" },
    ]);

    // Recovery must be attempted for the non-complete track.
    const { recoverTrack } = (await import("@/lib/recovery")) as unknown as {
      recoverTrack: ReturnType<typeof vi.fn>;
    };
    expect(recoverTrack).toHaveBeenCalledWith(
      "t2",
      expect.objectContaining({ chunkStitchMinAgeMs: expect.any(Number) }),
    );
  });

  it("finalizes when recovery flips a stuck track to complete", async () => {
    sessionStore.set("s5", {
      id: "s5",
      name: "demo",
      status: "recording",
      finalizedAt: null,
      tracks: [{ id: "t1", participantName: "Alice", status: "uploading" }],
    });

    // Recovery is a no-op in the standard mock — simulate it flipping the
    // track to complete so we exercise the "recovery enabled finalize" path.
    const { recoverTrack } = (await import("@/lib/recovery")) as unknown as {
      recoverTrack: ReturnType<typeof vi.fn>;
    };
    recoverTrack.mockImplementationOnce(async (trackId: string) => {
      const s = sessionStore.get("s5")!;
      s.tracks = s.tracks.map((t) =>
        t.id === trackId ? { ...t, status: "complete" } : t,
      );
      sessionStore.set("s5", s);
      return { trackId };
    });

    const res = await POST(req(), { params: Promise.resolve({ id: "s5" }) });
    expect(res.status).toBe(200);

    const body = (await res.json()) as Session;
    expect(body.status).toBe("ready");
    expect(body.finalizedAt).not.toBeNull();
  });

  it("treats recovery-failed tracks as terminal (does not block finalize)", async () => {
    sessionStore.set("s6", {
      id: "s6",
      name: "demo",
      status: "recording",
      finalizedAt: null,
      tracks: [{ id: "t1", participantName: "Alice", status: "uploading" }],
    });

    const { recoverTrack } = (await import("@/lib/recovery")) as unknown as {
      recoverTrack: ReturnType<typeof vi.fn>;
    };
    recoverTrack.mockImplementationOnce(async (trackId: string) => {
      const s = sessionStore.get("s6")!;
      s.tracks = s.tracks.map((t) =>
        t.id === trackId ? { ...t, status: "failed" } : t,
      );
      sessionStore.set("s6", s);
      return { trackId };
    });

    const res = await POST(req(), { params: Promise.resolve({ id: "s6" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Session;
    expect(body.status).toBe("ready");
  });

  it("returns 200 and flips the session to ready when all tracks are complete", async () => {
    sessionStore.set("s2", {
      id: "s2",
      name: "demo",
      status: "recording",
      finalizedAt: null,
      tracks: [
        { id: "t1", participantName: "Alice", status: "complete" },
        { id: "t2", participantName: "Bob", status: "complete" },
      ],
    });

    const before = Date.now();
    const res = await POST(req(), { params: Promise.resolve({ id: "s2" }) });
    expect(res.status).toBe(200);

    const body = (await res.json()) as Session;
    expect(body.status).toBe("ready");
    expect(body.finalizedAt).not.toBeNull();
    expect(new Date(body.finalizedAt!).getTime()).toBeGreaterThanOrEqual(before);

    expect(sessionStore.get("s2")?.status).toBe("ready");
  });

  it("is idempotent: already-ready returns 200 and does not re-stamp finalizedAt", async () => {
    const finalizedAt = new Date("2026-01-01T00:00:00.000Z");
    sessionStore.set("s3", {
      id: "s3",
      name: "demo",
      status: "ready",
      finalizedAt,
      tracks: [{ id: "t1", participantName: "Alice", status: "complete" }],
    });

    const res = await POST(req(), { params: Promise.resolve({ id: "s3" }) });
    expect(res.status).toBe(200);

    const body = (await res.json()) as Session;
    expect(body.status).toBe("ready");
    expect(new Date(body.finalizedAt!).toISOString()).toBe(finalizedAt.toISOString());

    // Confirm no write was performed.
    const { db } = (await import("@/lib/db")) as unknown as {
      db: {
        session: {
          update: ReturnType<typeof vi.fn>;
          updateMany: ReturnType<typeof vi.fn>;
        };
      };
    };
    expect(db.session.update).not.toHaveBeenCalled();
    expect(db.session.updateMany).not.toHaveBeenCalled();
  });

  it("two concurrent finalize calls return the same finalizedAt (only the first stamps)", async () => {
    sessionStore.set("s4", {
      id: "s4",
      name: "demo",
      status: "recording",
      finalizedAt: null,
      tracks: [{ id: "t1", participantName: "Alice", status: "complete" }],
    });

    // Pin the wall clock so any second stamping would otherwise advance it.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T00:00:00.000Z"));

    try {
      const promiseA = POST(req(), {
        params: Promise.resolve({ id: "s4" }),
      });
      // Move time forward; if a second updateMany stamped, we'd see this.
      vi.setSystemTime(new Date("2026-04-24T00:00:05.000Z"));
      const promiseB = POST(req(), {
        params: Promise.resolve({ id: "s4" }),
      });

      const [resA, resB] = await Promise.all([promiseA, promiseB]);

      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);

      const bodyA = (await resA.json()) as Session;
      const bodyB = (await resB.json()) as Session;

      expect(bodyA.finalizedAt).not.toBeNull();
      expect(bodyB.finalizedAt).not.toBeNull();
      expect(new Date(bodyA.finalizedAt!).toISOString()).toBe(
        new Date(bodyB.finalizedAt!).toISOString(),
      );

      // Exactly one updateMany should have actually flipped the row.
      const { db } = (await import("@/lib/db")) as unknown as {
        db: {
          session: {
            updateMany: ReturnType<typeof vi.fn>;
          };
        };
      };
      const counts = await Promise.all(
        db.session.updateMany.mock.results.map(
          (r) => r.value as Promise<{ count: number }>,
        ),
      );
      const flips = counts.filter((c) => c.count === 1).length;
      expect(flips).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
