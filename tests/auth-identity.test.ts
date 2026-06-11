import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SignJWT } from "jose";
import {
  issueGuestSessionCookie,
  issueHostSessionCookie,
  verifyGuestCookie,
  verifyHostCookie,
} from "@/lib/auth";

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "test-secret-for-auth-identity-token-123456");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("principal participant identity", () => {
  it("adds a stable participant id to host principals", async () => {
    const token = await issueHostSessionCookie();
    const principal = await verifyHostCookie(token);

    expect((principal as { participantId?: string } | null)?.participantId).toBe(
      "host",
    );
  });

  it("issues and verifies a server-generated guest participant id", async () => {
    const issued = await issueGuestSessionCookie("s1", "Alice");
    const participantId = (issued as { participantId?: string }).participantId;

    expect(participantId).toMatch(/^guest_[0-9a-f-]+$/);

    const principal = await verifyGuestCookie(issued.value, "s1");
    expect(principal).toMatchObject({
      kind: "guest",
      sessionId: "s1",
      name: "Alice",
      participantId,
    });
  });

  it("keeps guest identities scoped to their session cookie", async () => {
    const issued = await issueGuestSessionCookie("s1", "Alice");

    await expect(verifyGuestCookie(issued.value, "s2")).resolves.toBeNull();
  });

  it("keeps legacy guest cookies authenticated with a stable fallback participant id", async () => {
    const token = await issueLegacyGuestSessionCookie("s1", "Alice");

    const first = await verifyGuestCookie(token, "s1");
    const second = await verifyGuestCookie(token, "s1");

    expect(first).toMatchObject({
      kind: "guest",
      sessionId: "s1",
      name: "Alice",
    });
    expect(first?.participantId).toMatch(/^guest_legacy_[0-9a-f]{32}$/);
    expect(second?.participantId).toBe(first?.participantId);
  });
});

async function issueLegacyGuestSessionCookie(
  sessionId: string,
  name: string,
): Promise<string> {
  return await new SignJWT({ sessionId, name })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("cozytrack")
    .setAudience("cozytrack:guest")
    .setSubject(`guest:${sessionId}`)
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET));
}
