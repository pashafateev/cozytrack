import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
});
