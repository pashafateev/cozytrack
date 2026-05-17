import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../src/middleware";

function makeReq(
  url: string,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(url, { headers });
}

describe("src auth middleware ingest API", () => {
  beforeEach(() => {
    vi.stubEnv("COZYTRACK_API_KEY", "test-secret");
    vi.stubEnv("NODE_ENV", "production");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 when no ingest API key is provided", async () => {
    const res = await middleware(
      makeReq("http://localhost:3001/api/ingest/sessions")
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for a wrong ingest API key", async () => {
    const res = await middleware(
      makeReq("http://localhost:3001/api/ingest/sessions", {
        "x-api-key": "wrong",
      })
    );
    expect(res.status).toBe(401);
  });

  it("passes through with the correct ingest API key", async () => {
    const res = await middleware(
      makeReq("http://localhost:3001/api/ingest/sessions", {
        "x-api-key": "test-secret",
      })
    );
    expect(res.status).toBe(200);
  });

  it("bypasses ingest API auth in development from localhost", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const res = await middleware(
      makeReq("http://localhost:3001/api/ingest/sessions", {
        "x-forwarded-for": "127.0.0.1",
      })
    );
    expect(res.status).toBe(200);
  });
});
