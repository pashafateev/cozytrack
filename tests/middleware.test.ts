import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware, config as middlewareConfig } from "../middleware";

function makeReq(
  url: string,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(url, { headers });
}

describe("auth middleware", () => {
  beforeEach(() => {
    vi.stubEnv("COZYTRACK_API_KEY", "test-secret");
    vi.stubEnv("NODE_ENV", "production");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 when no API key is provided", () => {
    const res = middleware(
      makeReq("http://localhost:3001/api/ingest/sessions")
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for a wrong API key", () => {
    const res = middleware(
      makeReq("http://localhost:3001/api/ingest/sessions", {
        "x-api-key": "wrong",
      })
    );
    expect(res.status).toBe(401);
  });

  it("passes through with the correct API key", () => {
    const res = middleware(
      makeReq("http://localhost:3001/api/ingest/sessions", {
        "x-api-key": "test-secret",
      })
    );
    // NextResponse.next() is a 200 with internal pass-through headers.
    expect(res.status).toBe(200);
  });

  it("bypasses auth in development from localhost", () => {
    vi.stubEnv("NODE_ENV", "development");
    const res = middleware(
      makeReq("http://localhost:3001/api/ingest/sessions", {
        "x-forwarded-for": "127.0.0.1",
      })
    );
    expect(res.status).toBe(200);
  });
});

describe("middleware matcher", () => {
  it("only protects /api/ingest/* — not browser-facing routes", () => {
    expect(middlewareConfig.matcher).toEqual(["/api/ingest/:path*"]);
    // Sanity: the matcher must not contain anything that would gate the
    // browser-facing routes used by the studio UI.
    for (const pattern of middlewareConfig.matcher) {
      expect(pattern.startsWith("/api/sessions")).toBe(false);
      expect(pattern.startsWith("/api/tracks")).toBe(false);
    }
  });
});
