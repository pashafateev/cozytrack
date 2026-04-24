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

    // Confirm no update was performed.
    const { db } = (await import("@/lib/db")) as unknown as {
      db: { session: { update: ReturnType<typeof vi.fn> } };
    };
    expect(db.session.update).not.toHaveBeenCalled();
  });
});
