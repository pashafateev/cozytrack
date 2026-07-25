import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { decodeJwt, SignJWT } from "jose";
import { NextRequest } from "next/server";
import { middleware, config as middlewareConfig } from "../src/middleware";
import { verifyHostCookie } from "@/lib/auth";

const AUTH_SECRET = "test-secret-for-middleware-renewal-123456";
const secret = new TextEncoder().encode(AUTH_SECRET);
const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;

function makeReq(
  url: string,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(url, { headers });
}

async function hostToken(input: {
  issuedAt: number;
  expiresAt: number;
  firstIssuedAt?: number;
}): Promise<string> {
  return await new SignJWT(
    input.firstIssuedAt === undefined
      ? {}
      : { firstIssuedAt: input.firstIssuedAt },
  )
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("cozytrack")
    .setAudience("cozytrack:host")
    .setSubject("host")
    .setIssuedAt(input.issuedAt)
    .setExpirationTime(input.expiresAt)
    .sign(secret);
}

async function guestToken(input: {
  sessionId: string;
  name: string;
  participantId: string;
  issuedAt: number;
  expiresAt: number;
  firstIssuedAt: number;
}): Promise<string> {
  return await new SignJWT({
    sessionId: input.sessionId,
    name: input.name,
    participantId: input.participantId,
    firstIssuedAt: input.firstIssuedAt,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("cozytrack")
    .setAudience("cozytrack:guest")
    .setSubject(`guest:${input.sessionId}`)
    .setIssuedAt(input.issuedAt)
    .setExpirationTime(input.expiresAt)
    .sign(secret);
}

describe("auth middleware", () => {
  beforeEach(() => {
    vi.stubEnv("COZYTRACK_API_KEY", "test-secret");
    vi.stubEnv("AUTH_SECRET", AUTH_SECRET);
    vi.stubEnv("NODE_ENV", "production");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 when no API key is provided", async () => {
    const res = await middleware(
      makeReq("http://localhost:3001/api/ingest/sessions")
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for a wrong API key", async () => {
    const res = await middleware(
      makeReq("http://localhost:3001/api/ingest/sessions", {
        "x-api-key": "wrong",
      })
    );
    expect(res.status).toBe(401);
  });

  it("passes through with the correct API key", async () => {
    const res = await middleware(
      makeReq("http://localhost:3001/api/ingest/sessions", {
        "x-api-key": "test-secret",
      })
    );
    // NextResponse.next() is a 200 with internal pass-through headers.
    expect(res.status).toBe(200);
  });

  it("bypasses auth in development from localhost", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const res = await middleware(
      makeReq("http://localhost:3001/api/ingest/sessions", {
        "x-forwarded-for": "127.0.0.1",
      })
    );
    expect(res.status).toBe(200);
  });

  it("lets recording-token upload requests reach the route handler without cookies", async () => {
    const res = await middleware(
      makeReq("http://localhost:3001/api/upload/presign", {
        "x-cozytrack-recording-token": "recording-token",
      })
    );
    expect(res.status).toBe(200);
  });

  it("keeps upload requests without cookies or recording token unauthorized", async () => {
    const res = await middleware(
      makeReq("http://localhost:3001/api/upload/presign")
    );
    expect(res.status).toBe(401);
  });

  it("renews an active host cookie after the renewal threshold", async () => {
    const now = Math.floor(Date.now() / 1000);
    const issuedAt = now - 25 * HOUR_SECONDS;
    const token = await hostToken({
      issuedAt,
      firstIssuedAt: issuedAt,
      expiresAt: now + 6 * DAY_SECONDS,
    });
    const principal = await verifyHostCookie(token);
    expect(principal).toMatchObject({
      issuedAt,
      firstIssuedAt: issuedAt,
    });

    const req = makeReq("http://localhost:3001/dashboard");
    req.cookies.set("cozytrack_host", token);
    expect(req.cookies.get("cozytrack_host")?.value).toBe(token);
    const res = await middleware(req);

    const renewed = res.cookies.get("cozytrack_host")?.value;
    expect(renewed).toBeTruthy();
    expect(decodeJwt(renewed!).iat).toBeGreaterThan(issuedAt);
    expect(decodeJwt(renewed!).firstIssuedAt).toBe(issuedAt);
    expect(res.headers.get("set-cookie")).toContain(`Max-Age=${7 * DAY_SECONDS}`);
  });

  it("renews a guest cookie without changing participant identity or name", async () => {
    const now = Math.floor(Date.now() / 1000);
    const issuedAt = now - 2 * HOUR_SECONDS;
    const token = await guestToken({
      sessionId: "session-1",
      name: "Alice",
      participantId: "guest_stable",
      issuedAt,
      firstIssuedAt: issuedAt,
      expiresAt: now + 10 * HOUR_SECONDS,
    });

    const req = makeReq("http://localhost:3001/studio/session-1");
    req.cookies.set("cozytrack_guest_session-1", token);
    const res = await middleware(req);

    const renewed = res.cookies.get("cozytrack_guest_session-1")?.value;
    expect(renewed).toBeTruthy();
    expect(decodeJwt(renewed!)).toMatchObject({
      sessionId: "session-1",
      name: "Alice",
      participantId: "guest_stable",
      firstIssuedAt: issuedAt,
    });
  });

  it("does not renew a session that has reached its absolute cap", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await hostToken({
      issuedAt: now - 25 * HOUR_SECONDS,
      firstIssuedAt: now - 31 * DAY_SECONDS,
      expiresAt: now + HOUR_SECONDS,
    });

    const req = makeReq("http://localhost:3001/dashboard");
    req.cookies.set("cozytrack_host", token);
    const res = await middleware(req);

    expect(res.status).toBe(200);
    expect(res.cookies.get("cozytrack_host")).toBeUndefined();
  });

  it("caps a near-limit renewal at the remaining absolute lifetime", async () => {
    const now = Math.floor(Date.now() / 1000);
    const firstIssuedAt = now - (30 * DAY_SECONDS - HOUR_SECONDS);
    const token = await hostToken({
      issuedAt: now - 25 * HOUR_SECONDS,
      firstIssuedAt,
      expiresAt: now + 2 * HOUR_SECONDS,
    });
    const req = makeReq("http://localhost:3001/dashboard");
    req.cookies.set("cozytrack_host", token);

    const res = await middleware(req);

    const renewed = res.cookies.get("cozytrack_host")?.value;
    expect(renewed).toBeTruthy();
    expect(decodeJwt(renewed!).exp).toBe(firstIssuedAt + 30 * DAY_SECONDS);
    expect(res.headers.get("set-cookie")).toContain(
      `Max-Age=${HOUR_SECONDS}`,
    );
  });

  it("does not churn a host cookie before the renewal threshold", async () => {
    const now = Math.floor(Date.now() / 1000);
    const issuedAt = now - 23 * HOUR_SECONDS;
    const token = await hostToken({
      issuedAt,
      firstIssuedAt: issuedAt,
      expiresAt: now + 6 * DAY_SECONDS,
    });
    const req = makeReq("http://localhost:3001/dashboard");
    req.cookies.set("cozytrack_host", token);

    const res = await middleware(req);

    expect(res.status).toBe(200);
    expect(res.cookies.get("cozytrack_host")).toBeUndefined();
  });

  it("adds firstIssuedAt when renewing a cookie issued before sliding sessions", async () => {
    const now = Math.floor(Date.now() / 1000);
    const issuedAt = now - 25 * HOUR_SECONDS;
    const token = await hostToken({
      issuedAt,
      expiresAt: now + 6 * DAY_SECONDS,
    });

    const req = makeReq("http://localhost:3001/dashboard");
    req.cookies.set("cozytrack_host", token);
    const res = await middleware(req);

    const renewed = res.cookies.get("cozytrack_host")?.value;
    expect(renewed).toBeTruthy();
    expect(decodeJwt(renewed!).firstIssuedAt).toBe(issuedAt);
  });
});

describe("middleware matcher", () => {
  it("runs the app-wide auth middleware", () => {
    expect(middlewareConfig.matcher).toEqual([
      "/((?!_next/static|_next/image|favicon.ico).*)",
    ]);
  });
});
