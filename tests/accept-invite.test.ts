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
  it("preserves an existing guest participant id when re-accepting an invite", async () => {
    const token = await mintInviteToken("s1");
    const existing = await issueGuestSessionCookie("s1", "Alice");

    const req = request({ token, name: "Alice" });
    req.cookies.set(existing.cookieName, existing.value);

    const res = await acceptInvite(req);

    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toEqual(expect.stringContaining(existing.cookieName));

    const refreshedValue = cookieValue(setCookie ?? "", existing.cookieName);
    const refreshed = await verifyGuestCookie(refreshedValue, "s1");
    expect(refreshed?.participantId).toBe(existing.participantId);
  });
});
