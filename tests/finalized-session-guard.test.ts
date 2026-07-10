import { describe, it, expect, beforeEach, vi } from "vitest";

// Regression coverage for issue #151: a finalized ("ready") session must not
// accept new recording tracks. Before the guard, starting a new recording on
// an already-ingested session created a fresh take + tracks under the old
// session id, so the ingest command referenced audio that had already been
// handed off and could never be ingested.
//
// The guard also has to be atomic against a concurrent finalize (the race
// flagged in review): both the start guards and finalize take a per-session
// advisory lock via withSessionLock, so a finalize that flips the session to
// `ready` cannot interleave between a start guard's status read and its
// track/take creation. These tests drive the real withSessionLock code by
// mocking db.$transaction to invoke the callback with the same mock client.

type SessionRow = { status: string } | null;

const mocks = vi.hoisted(() => ({
  // Status returned by session.findUnique. A test may override per-call with
  // mockResolvedValueOnce to simulate a finalize landing mid-request.
  sessionStatus: "ready" as string | null,
  sessionFindUnique: vi.fn(),
  createTake: vi.fn(),
  createTrack: vi.fn(),
  createSegment: vi.fn(),
  findActiveTake: vi.fn(async () => null),
  resolvePrincipal: vi.fn(),
  issueRecordingUploadToken: vi.fn(async () => "token"),
  getPresignedPutUrl: vi.fn(async (key: string) => `https://s3.example/${key}`),
}));

const SESSION_ID = "finalized-session";

vi.mock("@/lib/db", () => {
  // The shape shared by both the top-level client and the transaction client
  // handed to withSessionLock's callback. $transaction just runs the callback
  // with this same object so tx.* calls hit the same spies.
  const client = {
    $executeRaw: vi.fn(async () => 0),
    session: { findUnique: mocks.sessionFindUnique },
    recordingTake: {
      findFirst: mocks.findActiveTake,
      create: mocks.createTake,
      update: vi.fn(),
    },
    track: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      create: mocks.createTrack,
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    trackSegment: {
      findUnique: vi.fn(async () => null),
      create: mocks.createSegment,
      count: vi.fn(async () => 0),
    },
  };
  return {
    db: {
      ...client,
      $transaction: async (fn: (tx: typeof client) => Promise<unknown>) =>
        fn(client),
    },
  };
});

vi.mock("@/lib/s3", async () => {
  const actual = await vi.importActual<typeof import("@/lib/s3")>("@/lib/s3");
  return { ...actual, getPresignedPutUrl: mocks.getPresignedPutUrl };
});

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    resolvePrincipal: mocks.resolvePrincipal,
    issueRecordingUploadToken: mocks.issueRecordingUploadToken,
  };
});

import { NextRequest } from "next/server";
import { POST as setRecordingState } from "@/app/api/sessions/[id]/recording-state/route";
import { POST as presign } from "@/app/api/upload/presign/route";

function recordingStateRequest(body: Record<string, unknown>) {
  return new NextRequest(
    `http://localhost/api/sessions/${SESSION_ID}/recording-state`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function presignRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/upload/presign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessionStatus = "ready";
  mocks.sessionFindUnique.mockImplementation(async () =>
    mocks.sessionStatus === null
      ? null
      : ({ id: SESSION_ID, status: mocks.sessionStatus } as SessionRow),
  );
  mocks.resolvePrincipal.mockResolvedValue({
    kind: "host",
    participantId: "host",
  });
  mocks.findActiveTake.mockResolvedValue(null);
});

describe("finalized session recording guard (issue #151)", () => {
  it("rejects starting a new recording take on a finalized session", async () => {
    const res = await setRecordingState(
      recordingStateRequest({
        active: true,
        sessionStartedAt: "2026-06-27T12:00:00.000Z",
      }),
      { params: Promise.resolve({ id: SESSION_ID }) },
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("finalized"),
    });
    expect(mocks.createTake).not.toHaveBeenCalled();
  });

  it("rejects presigning a new recording upload on a finalized session", async () => {
    const res = await presign(
      presignRequest({
        sessionId: SESSION_ID,
        trackId: "new-track",
        partNumber: 0,
        participantName: "Marty L",
      }),
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("finalized"),
    });
    expect(mocks.createTrack).not.toHaveBeenCalled();
    expect(mocks.createSegment).not.toHaveBeenCalled();
    expect(mocks.issueRecordingUploadToken).not.toHaveBeenCalled();
    expect(mocks.getPresignedPutUrl).not.toHaveBeenCalled();
  });

  it("rejects a presign start when finalize lands after the early status read (race)", async () => {
    // Early existence/status check sees "recording" (finalize hasn't committed
    // yet), but the re-read inside withSessionLock sees "ready" — the exact
    // check-then-create window the advisory lock closes. Must still 409 and
    // must not materialize a track or issue a writable URL.
    mocks.sessionFindUnique
      .mockResolvedValueOnce({ id: SESSION_ID, status: "recording" })
      .mockResolvedValue({ id: SESSION_ID, status: "ready" });

    const res = await presign(
      presignRequest({
        sessionId: SESSION_ID,
        trackId: "new-track",
        partNumber: 0,
        participantName: "Marty L",
      }),
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("finalized"),
    });
    expect(mocks.createTrack).not.toHaveBeenCalled();
    expect(mocks.getPresignedPutUrl).not.toHaveBeenCalled();
  });

  it("rejects a recording-take start when finalize lands after the existence check (race)", async () => {
    // requireSession sees "recording"; the in-lock re-read sees "ready".
    mocks.sessionFindUnique
      .mockResolvedValueOnce({ id: SESSION_ID, status: "recording" })
      .mockResolvedValue({ id: SESSION_ID, status: "ready" });

    const res = await setRecordingState(
      recordingStateRequest({
        active: true,
        sessionStartedAt: "2026-06-27T12:00:00.000Z",
      }),
      { params: Promise.resolve({ id: SESSION_ID }) },
    );

    expect(res.status).toBe(409);
    expect(mocks.createTake).not.toHaveBeenCalled();
  });

  it("still allows recording into a session that is still recording", async () => {
    mocks.sessionStatus = "recording";
    mocks.createTake.mockResolvedValue({
      id: "take-1",
      sessionId: SESSION_ID,
      startedAt: new Date("2026-06-27T12:00:00.000Z"),
      stoppedAt: null,
      status: "recording",
      participantStatuses: [],
    });

    const res = await setRecordingState(
      recordingStateRequest({
        active: true,
        sessionStartedAt: "2026-06-27T12:00:00.000Z",
      }),
      { params: Promise.resolve({ id: SESSION_ID }) },
    );

    expect(res.status).toBe(200);
    expect(mocks.createTake).toHaveBeenCalledTimes(1);
  });
});
