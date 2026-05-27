import { describe, it, expect, beforeEach, vi } from "vitest";

type Track = {
  id: string;
  s3Key: string;
  s3PurgedAt: Date | null;
};

const mocks = vi.hoisted(() => ({
  trackStore: new Map<string, Track>(),
  getPresignedGetUrl: vi.fn(async () => "https://example.com/download"),
  verifyHostCookie: vi.fn(async () => ({ kind: "host" })),
}));

vi.mock("@/lib/db", () => ({
  db: {
    track: {
      findUnique: vi.fn(
        async ({ where: { id } }: { where: { id: string } }) => {
          const track = mocks.trackStore.get(id);
          return track ? { ...track } : null;
        },
      ),
    },
  },
}));

vi.mock("@/lib/s3", () => ({
  getPresignedGetUrl: mocks.getPresignedGetUrl,
}));

vi.mock("@/lib/auth", () => ({
  AUTH_COOKIES: { host: "ct_host" },
  verifyHostCookie: mocks.verifyHostCookie,
}));

import { NextRequest } from "next/server";
import { GET as browserDownload } from "@/app/api/tracks/[id]/download/route";
import { GET as ingestDownload } from "@/app/api/ingest/tracks/[id]/download/route";

function req(path: string): NextRequest {
  return new NextRequest(`http://localhost:3001${path}`);
}

beforeEach(() => {
  mocks.trackStore.clear();
  vi.clearAllMocks();
});

describe("track download routes", () => {
  it("returns 410 for purged browser downloads", async () => {
    mocks.trackStore.set("t1", {
      id: "t1",
      s3Key: "sessions/s1/tracks/t1/recording.webm",
      s3PurgedAt: new Date("2026-05-10T12:00:00.000Z"),
    });

    const res = await browserDownload(req("/api/tracks/t1/download"), {
      params: Promise.resolve({ id: "t1" }),
    });

    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Track recording has been purged");
    expect(mocks.getPresignedGetUrl).not.toHaveBeenCalled();
  });

  it("returns 410 for purged ingest downloads", async () => {
    mocks.trackStore.set("t2", {
      id: "t2",
      s3Key: "sessions/s1/tracks/t2/recording.webm",
      s3PurgedAt: new Date("2026-05-10T12:00:00.000Z"),
    });

    const res = await ingestDownload(
      req("/api/ingest/tracks/t2/download"),
      {
        params: Promise.resolve({ id: "t2" }),
      },
    );

    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Track recording has been purged");
    expect(mocks.getPresignedGetUrl).not.toHaveBeenCalled();
  });
});
