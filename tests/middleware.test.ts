import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../middleware";

function makeReq(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3001/api/sessions", { headers });
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
    const res = middleware(makeReq());
    expect(res.status).toBe(401);
  });

  it("returns 401 for a wrong API key", () => {
    const res = middleware(makeReq({ "x-api-key": "wrong" }));
    expect(res.status).toBe(401);
  });

  it("passes through with the correct API key", () => {
    const res = middleware(makeReq({ "x-api-key": "test-secret" }));
    // NextResponse.next() is a 200 with internal pass-through headers.
    expect(res.status).toBe(200);
  });

  it("bypasses auth in development from localhost", () => {
    vi.stubEnv("NODE_ENV", "development");
    const res = middleware(makeReq({ "x-forwarded-for": "127.0.0.1" }));
    expect(res.status).toBe(200);
  });
});
