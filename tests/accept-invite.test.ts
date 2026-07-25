import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  issueGuestSessionCookie,
  mintInviteToken,
  verifyGuestCookie,
} from "@/lib/auth";
import { POST as acceptInvite } from "@/app/api/auth/accept-invite/route";

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "test-secret-for-accept-invite-token-123456");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/auth/accept-invite", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function cookieValue(setCookie: string, cookieName: string): string {
  const match = new RegExp(`${cookieName}=([^;]+)`).exec(setCookie);
  if (!match?.[1]) throw new Error(`Missing ${cookieName} cookie`);
  return match[1];
}

describe("POST /api/auth/accept-invite", () => {
  it("preserves guest identity while updating the name on re-acceptance", async () => {
    const token = await mintInviteToken("s1");
    const existing = await issueGuestSessionCookie("s1", "Alice");

    const req = request({ token, name: "Renamed Alice" });
    req.cookies.set(existing.cookieName, existing.value);

    const res = await acceptInvite(req);

    expect(res.status).toBe(200);
    const refreshedValue = cookieValue(
      res.headers.get("set-cookie") ?? "",
      existing.cookieName,
    );
    const refreshed = await verifyGuestCookie(refreshedValue, "s1");

    expect(refreshed).toMatchObject({
      kind: "guest",
      sessionId: "s1",
      name: "Renamed Alice",
      participantId: existing.participantId,
    });
  });
});
