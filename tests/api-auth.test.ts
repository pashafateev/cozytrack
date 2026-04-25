import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { isApiAuthorized } from "@/lib/api-auth";

function makeReq(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3001/api/sessions", { headers });
}

describe("isApiAuthorized", () => {
  beforeEach(() => {
    vi.stubEnv("COZYTRACK_API_KEY", "test-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects requests with no API key in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isApiAuthorized(makeReq())).toBe(false);
  });

  it("rejects requests with the wrong API key", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isApiAuthorized(makeReq({ "x-api-key": "nope" }))).toBe(false);
  });

  it("accepts requests with the correct API key", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isApiAuthorized(makeReq({ "x-api-key": "test-secret" }))).toBe(true);
  });

  it("bypasses auth in development for 127.0.0.1 via x-forwarded-for", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(
      isApiAuthorized(makeReq({ "x-forwarded-for": "127.0.0.1" })),
    ).toBe(true);
  });

  it("bypasses auth in development for ::1 via x-forwarded-for", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isApiAuthorized(makeReq({ "x-forwarded-for": "::1" }))).toBe(true);
  });

  it("bypasses auth in development when no forwarding header is set", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isApiAuthorized(makeReq())).toBe(true);
  });

  it("does NOT bypass in development when request comes from a non-local address", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(
      isApiAuthorized(makeReq({ "x-forwarded-for": "10.0.0.5" })),
    ).toBe(false);
  });

  it("rejects when COZYTRACK_API_KEY is unset in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COZYTRACK_API_KEY", "");
    expect(
      isApiAuthorized(makeReq({ "x-api-key": "anything" })),
    ).toBe(false);
  });
});
