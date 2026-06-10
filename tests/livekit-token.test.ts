import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolvePrincipal: vi.fn(),
  accessTokens: [] as Array<{
    apiKey: string | undefined;
    apiSecret: string | undefined;
    options: Record<string, unknown> | undefined;
    grants: unknown[];
  }>,
}));

vi.mock("livekit-server-sdk", () => ({
  AccessToken: vi.fn().mockImplementation(function (
    this: {
      apiKey: string | undefined;
      apiSecret: string | undefined;
      options: Record<string, unknown> | undefined;
      grants: unknown[];
      addGrant: (grant: unknown) => void;
      toJwt: () => Promise<string>;
    },
    apiKey: string | undefined,
    apiSecret: string | undefined,
    options: Record<string, unknown> | undefined,
  ) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.options = options;
    this.grants = [];
    this.addGrant = (grant: unknown) => {
      this.grants.push(grant);
    };
    this.toJwt = async () => "test-livekit-token";
    mocks.accessTokens.push(this);
  }),
}));

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>(
    "@/lib/auth",
  );
  return {
    ...actual,
    resolvePrincipal: mocks.resolvePrincipal,
  };
});

import { NextRequest } from "next/server";
import { POST as issueLiveKitToken } from "@/app/api/livekit-token/route";

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost:3001/api/livekit-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv("LIVEKIT_API_KEY", "lk-key");
  vi.stubEnv("LIVEKIT_API_SECRET", "lk-secret");
  mocks.resolvePrincipal.mockReset();
  mocks.accessTokens.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/api/livekit-token participant identity", () => {
  it("uses the host principal id as LiveKit identity and display name as metadata", async () => {
    mocks.resolvePrincipal.mockResolvedValue({ kind: "host", participantId: "host" });

    const res = await issueLiveKitToken(
      request({ roomName: "s1", participantName: " Host Name " }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ token: "test-livekit-token" });
    expect(mocks.accessTokens[0]).toMatchObject({
      apiKey: "lk-key",
      apiSecret: "lk-secret",
      options: {
        identity: "host",
        name: "Host Name",
        metadata: JSON.stringify({
          role: "host",
          participantId: "host",
          displayName: "Host Name",
        }),
      },
      grants: [{ roomJoin: true, room: "s1" }],
    });
  });

  it("uses the guest cookie participant id instead of the mutable display name", async () => {
    mocks.resolvePrincipal.mockResolvedValue({
      kind: "guest",
      sessionId: "s1",
      name: "Cookie Alice",
      participantId: "guest_abc",
    });

    const res = await issueLiveKitToken(
      request({ roomName: "s1", participantName: "Renamed Alice" }),
    );

    expect(res.status).toBe(200);
    expect(mocks.accessTokens[0]?.options).toEqual({
      identity: "guest_abc",
      name: "Renamed Alice",
      metadata: JSON.stringify({
        role: "guest",
        participantId: "guest_abc",
        displayName: "Renamed Alice",
      }),
    });
  });
});
