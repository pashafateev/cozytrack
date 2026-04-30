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
      findMany: vi.fn(
        async ({ where }: { where?: { status?: string } } = {}) => {
          const all = Array.from(sessionStore.values());
          if (where?.status) {
            return all.filter((s) => s.status === where.status);
          }
          return all;
        },
      ),
    },
  },
}));

// Browser-facing /api/sessions is gated by the host cookie. The test exercises
// the status-filter validation, not the auth boundary, so we stub the cookie
// verifier to always resolve a host principal.
vi.mock("@/lib/auth", () => ({
  AUTH_COOKIES: { host: "ct_host", guest: "ct_guest" },
  verifyHostCookie: vi.fn(async () => ({ kind: "host" })),
}));

import { NextRequest } from "next/server";
import { GET as listBrowserSessions } from "@/app/api/sessions/route";
import { GET as listIngestSessions } from "@/app/api/ingest/sessions/route";

beforeEach(() => {
  sessionStore.clear();
  vi.clearAllMocks();
  sessionStore.set("a", {
    id: "a",
    name: "a",
    status: "recording",
    finalizedAt: null,
    tracks: [],
  });
  sessionStore.set("b", {
    id: "b",
    name: "b",
    status: "ready",
    finalizedAt: new Date(),
    tracks: [],
  });
});

function req(url: string): NextRequest {
  return new NextRequest(url);
}

describe("GET /api/sessions ?status= validation", () => {
  it("returns all sessions when no status filter is given", async () => {
    const res = await listBrowserSessions(req("http://localhost/api/sessions"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Session[];
    expect(body).toHaveLength(2);
  });

  it("filters by status=recording", async () => {
    const res = await listBrowserSessions(
      req("http://localhost/api/sessions?status=recording"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Session[];
    expect(body.map((s) => s.status)).toEqual(["recording"]);
  });

  it("filters by status=ready", async () => {
    const res = await listBrowserSessions(
      req("http://localhost/api/sessions?status=ready"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Session[];
    expect(body.map((s) => s.status)).toEqual(["ready"]);
  });

  it("rejects unsupported status values with 400", async () => {
    const res = await listBrowserSessions(
      req("http://localhost/api/sessions?status=garbage"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid status filter");
  });
});

describe("GET /api/ingest/sessions ?status= validation", () => {
  it("filters by status=ready", async () => {
    const res = await listIngestSessions(
      req("http://localhost/api/ingest/sessions?status=ready"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Session[];
    expect(body.map((s) => s.status)).toEqual(["ready"]);
  });

  it("rejects unsupported status values with 400", async () => {
    const res = await listIngestSessions(
      req("http://localhost/api/ingest/sessions?status=foo"),
    );
    expect(res.status).toBe(400);
  });
});
