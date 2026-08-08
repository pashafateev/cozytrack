import { describe, it, expect, beforeEach, vi } from "vitest";

type RecordingTake = {
  id: string;
  sessionId: string;
  startedAt: Date;
  stoppedAt: Date | null;
  status: string;
  participantStatuses?: RecordingTakeParticipantStatus[];
};

type RecordingTakeParticipantStatus = {
  takeId: string;
  participantId: string;
  participantName: string | null;
  readinessStatus: string | null;
  recordingStatus: string | null;
  statusReason: string | null;
  updatedAt: Date;
};

type Track = {
  id: string;
  takeId: string;
  participantId: string | null;
  status: string;
};

const mocks = vi.hoisted(() => ({
  sessions: new Set<string>(),
  takes: new Map<string, RecordingTake>(),
  tracks: new Map<string, Track>(),
  participantStatuses: new Map<string, RecordingTakeParticipantStatus>(),
  resolvePrincipal: vi.fn(),
  roomServiceConstructor: vi.fn(),
  listParticipants: vi.fn(),
  recoverTrack: vi.fn(),
  recoverStoppedTakeTracks: vi.fn(),
  nextTakeId: 1,
}));

function cloneTake(take: RecordingTake): RecordingTake {
  return structuredClone({
    ...take,
    participantStatuses: Array.from(mocks.participantStatuses.values())
      .filter((status) => status.takeId === take.id)
      .map((status) => ({ ...status })),
  });
}

function activeTakeFor(sessionId: string): RecordingTake | null {
  return (
    Array.from(mocks.takes.values()).find(
      (take) => take.sessionId === sessionId && take.status === "recording",
    ) ?? null
  );
}

vi.mock("@/lib/db", () => {
  const client = {
    // withSessionLock runs its callback inside db.$transaction and issues a raw
    // advisory-lock query; the mock just needs these to exist and pass through.
    $executeRaw: async () => 0,
    session: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) =>
        mocks.sessions.has(id) ? { id } : null,
      ),
    },
    recordingTake: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { sessionId: string; status?: string; stoppedAt?: null };
        }) => {
          let take: RecordingTake | null = null;
          if (where.status === "recording" || where.stoppedAt === null) {
            take = activeTakeFor(where.sessionId);
          } else {
            take =
              Array.from(mocks.takes.values()).find(
                (candidate) => candidate.sessionId === where.sessionId,
              ) ?? null;
          }
          return take ? cloneTake(take) : null;
        },
      ),
      findUnique: vi.fn(
        async ({ where: { id } }: { where: { id: string } }) => {
          const take = mocks.takes.get(id);
          return take ? cloneTake(take) : null;
        },
      ),
      create: vi.fn(
        async ({
          data,
        }: {
          data: { sessionId: string; startedAt: Date; status?: string };
        }) => {
          const take: RecordingTake = {
            id: `take-${mocks.nextTakeId++}`,
            sessionId: data.sessionId,
            startedAt: data.startedAt,
            stoppedAt: null,
            status: data.status ?? "recording",
          };
          mocks.takes.set(take.id, take);
          return cloneTake(take);
        },
      ),
      update: vi.fn(
        async ({
          where: { id },
          data,
        }: {
          where: { id: string };
          data: { stoppedAt?: Date | null; status?: string };
        }) => {
          const take = mocks.takes.get(id);
          if (!take) throw new Error("take not found");
          const updated = { ...take, ...data };
          mocks.takes.set(id, updated);
          return cloneTake(updated);
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; sessionId?: string; status?: string };
          data: { stoppedAt?: Date | null; status?: string };
        }) => {
          const take = mocks.takes.get(where.id);
          if (!take) return { count: 0 };
          if (where.sessionId !== undefined && take.sessionId !== where.sessionId) {
            return { count: 0 };
          }
          if (where.status !== undefined && take.status !== where.status) {
            return { count: 0 };
          }
          mocks.takes.set(where.id, { ...take, ...data });
          return { count: 1 };
        },
      ),
    },
    recordingTakeParticipantStatus: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            takeId: string;
            participantId: { in: string[] };
          };
        }) =>
          Array.from(mocks.participantStatuses.values())
            .filter(
              (status) =>
                status.takeId === where.takeId &&
                where.participantId.in.includes(status.participantId),
            )
            .map((status) => ({ ...status })),
      ),
      upsert: vi.fn(
        async ({
          where: { takeId_participantId },
          create,
          update,
        }: {
          where: {
            takeId_participantId: { takeId: string; participantId: string };
          };
          create: RecordingTakeParticipantStatus;
          update: Partial<RecordingTakeParticipantStatus>;
        }) => {
          const key = `${takeId_participantId.takeId}:${takeId_participantId.participantId}`;
          const existing = mocks.participantStatuses.get(key);
          const next = existing
            ? { ...existing, ...update, updatedAt: new Date() }
            : { ...create, updatedAt: new Date() };
          mocks.participantStatuses.set(key, next);
          return { ...next };
        },
      ),
    },
    track: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { takeId: string; status?: { notIn?: string[] } };
        }) =>
          Array.from(mocks.tracks.values())
            .filter(
              (track) =>
                track.takeId === where.takeId &&
                !where.status?.notIn?.includes(track.status),
            )
            .map((track) => ({ ...track })),
      ),
    },
  };
  let transactionTail = Promise.resolve();
  const transaction = vi.fn(
    async (fn: (tx: typeof client) => Promise<unknown>) => {
      const previous = transactionTail;
      let release: () => void = () => {};
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await fn(client);
      } finally {
        release();
      }
    },
  );
  return {
    db: {
      ...client,
      $transaction: transaction,
    },
  };
});

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>(
    "@/lib/auth",
  );
  return {
    ...actual,
    resolvePrincipal: mocks.resolvePrincipal,
  };
});

vi.mock("@/lib/recovery", () => ({
  recoverTrack: mocks.recoverTrack,
  recoverStoppedTakeTracks: mocks.recoverStoppedTakeTracks,
}));

vi.mock("livekit-server-sdk", () => ({
  RoomServiceClient: class {
    constructor(...args: unknown[]) {
      mocks.roomServiceConstructor(...args);
    }

    listParticipants(room: string) {
      return mocks.listParticipants(room);
    }
  },
}));

import { NextRequest } from "next/server";
import {
  GET as getRecordingState,
  PATCH as reportRecordingState,
  POST as setRecordingState,
} from "@/app/api/sessions/[id]/recording-state/route";
import { withSessionLock } from "@/lib/session-lock";

function params(id = "s1") {
  return { params: Promise.resolve({ id }) };
}

function request(method: "GET" | "PATCH" | "POST", body?: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/sessions/s1/recording-state", {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  mocks.sessions.clear();
  mocks.takes.clear();
  mocks.tracks.clear();
  mocks.participantStatuses.clear();
  mocks.sessions.add("s1");
  mocks.nextTakeId = 1;
  vi.clearAllMocks();
  vi.stubEnv("LIVEKIT_URL", "ws://127.0.0.1:7880");
  vi.stubEnv("LIVEKIT_API_KEY", "devkey");
  vi.stubEnv("LIVEKIT_API_SECRET", "devsecret");
  mocks.resolvePrincipal.mockResolvedValue({
    kind: "host",
    participantId: "host",
  });
  mocks.listParticipants.mockResolvedValue([]);
  mocks.recoverTrack.mockImplementation(async (trackId: string) => {
    const track = mocks.tracks.get(trackId);
    if (track) mocks.tracks.set(trackId, { ...track, status: "complete" });
    return {
      trackId,
      outcome: "recovered_from_chunks",
      partial: false,
      status: "complete",
      chunkCount: 1,
      missingPartNumbers: [],
    };
  });
  mocks.recoverStoppedTakeTracks.mockResolvedValue([]);
});

describe("/api/sessions/[id]/recording-state", () => {
  it("recovers an absent guest on the stopped-take retry without touching host-owned recorders", async () => {
    mocks.takes.set("take-1", {
      id: "take-1",
      sessionId: "s1",
      startedAt: new Date("2026-06-01T12:00:00.000Z"),
      stoppedAt: null,
      status: "recording",
    });
    mocks.tracks.set("track-host", {
      id: "track-host",
      takeId: "take-1",
      participantId: "host",
      status: "recording",
    });
    mocks.tracks.set("track-host-channel", {
      id: "track-host-channel",
      takeId: "take-1",
      participantId: "host-local-ch-1",
      status: "recording",
    });
    mocks.tracks.set("track-guest", {
      id: "track-guest",
      takeId: "take-1",
      participantId: "guest_disconnected",
      status: "recording",
    });
    mocks.participantStatuses.set("take-1:guest_disconnected", {
      takeId: "take-1",
      participantId: "guest_disconnected",
      participantName: "Disconnected Guest",
      readinessStatus: "ready",
      recordingStatus: "recording",
      statusReason: null,
      updatedAt: new Date(),
    });
    const stopped = await setRecordingState(
      request("POST", { active: false, takeId: "take-1" }),
      params(),
    );

    expect(stopped.status).toBe(200);
    expect(mocks.takes.get("take-1")?.status).toBe("stopped");
    await expect(stopped.json()).resolves.toMatchObject({
      active: false,
      recoveryPending: true,
    });
    expect(mocks.recoverTrack).not.toHaveBeenCalled();
    const stoppedAt = mocks.takes.get("take-1")?.stoppedAt;
    expect(stoppedAt).toBeInstanceOf(Date);
    mocks.listParticipants
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        {
          identity: "guest_disconnected",
          joinedAt: BigInt(0),
          joinedAtMs: BigInt(stoppedAt!.getTime() + 2_000),
        },
      ]);

    vi.useFakeTimers();
    let retried: Response;
    try {
      const recovery = setRecordingState(
        request("POST", { active: false, takeId: "take-1" }),
        params(),
      );
      await vi.advanceTimersByTimeAsync(6_000);
      retried = await recovery;
    } finally {
      vi.useRealTimers();
    }

    expect(retried.status).toBe(200);
    expect((await retried.json()).recoveryPending).toBeUndefined();
    expect(mocks.listParticipants).toHaveBeenCalledWith("s1");
    expect(mocks.roomServiceConstructor).toHaveBeenCalledWith(
      "ws://127.0.0.1:7880",
      "devkey",
      "devsecret",
      { requestTimeout: 5 },
    );
    expect(mocks.recoverTrack).toHaveBeenCalledTimes(1);
    expect(mocks.recoverTrack).toHaveBeenCalledWith("track-guest", {
      chunkStitchMinAgeMs: 30_000,
    });
    expect(mocks.recoverTrack).not.toHaveBeenCalledWith("track-host");
    expect(mocks.recoverTrack).not.toHaveBeenCalledWith("track-host-channel");
  });

  it("does not add a guest that disconnects after the recovery snapshot", async () => {
    mocks.takes.set("take-1", {
      id: "take-1",
      sessionId: "s1",
      startedAt: new Date("2026-06-01T12:00:00.000Z"),
      stoppedAt: null,
      status: "recording",
    });
    mocks.tracks.set("track-guest", {
      id: "track-guest",
      takeId: "take-1",
      participantId: "guest_late_disconnect",
      status: "recording",
    });
    mocks.participantStatuses.set("take-1:guest_late_disconnect", {
      takeId: "take-1",
      participantId: "guest_late_disconnect",
      participantName: "Late Disconnect Guest",
      readinessStatus: "ready",
      recordingStatus: "recording",
      statusReason: null,
      updatedAt: new Date(),
    });
    mocks.listParticipants
      .mockResolvedValueOnce([{ identity: "guest_late_disconnect" }])
      .mockResolvedValue([]);

    const stopped = await setRecordingState(
      request("POST", { active: false, takeId: "take-1" }),
      params(),
    );

    expect(stopped.status).toBe(200);
    await expect(stopped.json()).resolves.toMatchObject({
      recoveryPending: true,
    });

    vi.useFakeTimers();
    let retried: Response;
    try {
      const recovery = setRecordingState(
        request("POST", { active: false, takeId: "take-1" }),
        params(),
      );
      await vi.advanceTimersByTimeAsync(45_000);
      retried = await recovery;
    } finally {
      vi.useRealTimers();
    }

    await expect(retried.json()).resolves.toMatchObject({
      recoveryPending: true,
    });
    expect(mocks.recoverTrack).not.toHaveBeenCalled();
  });

  it("drops a disconnected recovery candidate that starts finalizing", async () => {
    mocks.takes.set("take-1", {
      id: "take-1",
      sessionId: "s1",
      startedAt: new Date("2026-06-01T12:00:00.000Z"),
      stoppedAt: null,
      status: "recording",
    });
    mocks.tracks.set("track-guest", {
      id: "track-guest",
      takeId: "take-1",
      participantId: "guest_finalizing",
      status: "recording",
    });
    const status: RecordingTakeParticipantStatus = {
      takeId: "take-1",
      participantId: "guest_finalizing",
      participantName: "Finalizing Guest",
      readinessStatus: "ready",
      recordingStatus: "recording",
      statusReason: null,
      updatedAt: new Date(),
    };
    mocks.participantStatuses.set("take-1:guest_finalizing", status);
    mocks.listParticipants.mockResolvedValue([]);

    const stopped = await setRecordingState(
      request("POST", { active: false, takeId: "take-1" }),
      params(),
    );
    expect(stopped.status).toBe(200);

    vi.useFakeTimers();
    let retried: Response;
    try {
      const recovery = setRecordingState(
        request("POST", { active: false, takeId: "take-1" }),
        params(),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      mocks.participantStatuses.set("take-1:guest_finalizing", {
        ...status,
        recordingStatus: "finalizing",
        updatedAt: new Date(),
      });
      await vi.advanceTimersByTimeAsync(44_000);
      retried = await recovery;
    } finally {
      vi.useRealTimers();
    }

    await expect(retried.json()).resolves.toMatchObject({
      recoveryPending: true,
    });
    expect(mocks.recoverTrack).not.toHaveBeenCalled();
  });

  it("acknowledges a durable stop while track recovery remains pending", async () => {
    mocks.takes.set("take-1", {
      id: "take-1",
      sessionId: "s1",
      startedAt: new Date("2026-06-01T12:00:00.000Z"),
      stoppedAt: null,
      status: "recording",
    });
    mocks.recoverStoppedTakeTracks.mockRejectedValue(
      new Error("transient recovery failure"),
    );

    const stopped = await setRecordingState(
      request("POST", { active: false, takeId: "take-1" }),
      params(),
    );

    expect(stopped.status).toBe(200);
    await expect(stopped.json()).resolves.toMatchObject({
      active: false,
      recoveryPending: true,
      take: {
        id: "take-1",
        status: "stopped",
      },
    });
    expect(mocks.takes.get("take-1")?.status).toBe("stopped");

    const retried = await setRecordingState(
      request("POST", { active: false, takeId: "take-1" }),
      params(),
    );

    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toMatchObject({
      active: false,
      recoveryPending: true,
      take: {
        id: "take-1",
        status: "stopped",
      },
    });
    expect(mocks.recoverStoppedTakeTracks).toHaveBeenCalledTimes(2);
    expect(mocks.recoverStoppedTakeTracks).toHaveBeenCalledWith("take-1");
  });

  it("lets hosts create, read, and close an active recording take", async () => {
    const startedAt = "2026-06-01T12:00:00.000Z";

    const start = await setRecordingState(
      request("POST", { active: true, sessionStartedAt: startedAt }),
      params(),
    );
    expect(start.status).toBe(200);
    await expect(start.json()).resolves.toMatchObject({
      active: true,
      sessionStartedAt: startedAt,
      take: {
        id: "take-1",
        sessionId: "s1",
        startedAt,
        stoppedAt: null,
      },
    });

    const read = await getRecordingState(request("GET"), params());
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      active: true,
      sessionStartedAt: startedAt,
      take: { id: "take-1", startedAt, stoppedAt: null },
    });

    const stop = await setRecordingState(request("POST", { active: false }), params());
    expect(stop.status).toBe(200);
    const stopBody = (await stop.json()) as {
      active: boolean;
      sessionStartedAt: string | null;
      take: { id: string; stoppedAt: string | null };
    };
    expect(stopBody.active).toBe(false);
    expect(stopBody.sessionStartedAt).toBeNull();
    expect(stopBody.take.id).toBe("take-1");
    expect(stopBody.take.stoppedAt).toEqual(expect.any(String));
    expect(mocks.recoverStoppedTakeTracks).toHaveBeenCalledWith("take-1");

    const inactiveRead = await getRecordingState(request("GET"), params());
    await expect(inactiveRead.json()).resolves.toMatchObject({
      active: false,
      sessionStartedAt: null,
      take: null,
    });
  });

  it("reuses the current active take when host start is repeated", async () => {
    const first = await setRecordingState(
      request("POST", {
        active: true,
        sessionStartedAt: "2026-06-01T12:00:00.000Z",
      }),
      params(),
    );
    const second = await setRecordingState(
      request("POST", {
        active: true,
        sessionStartedAt: "2026-06-01T12:05:00.000Z",
      }),
      params(),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      active: true,
      sessionStartedAt: "2026-06-01T12:00:00.000Z",
      take: { id: "take-1" },
    });
    expect(mocks.takes).toHaveLength(1);
  });

  it("allows guests to read but not mutate room-level active state", async () => {
    mocks.resolvePrincipal.mockResolvedValue({
      kind: "guest",
      sessionId: "s1",
      name: "Alice",
      participantId: "guest_alice",
    });

    const read = await getRecordingState(request("GET"), params());
    expect(read.status).toBe(200);

    const write = await setRecordingState(
      request("POST", {
        active: true,
        sessionStartedAt: "2026-06-01T12:00:00.000Z",
      }),
      params(),
    );
    expect(write.status).toBe(403);
    expect(mocks.takes).toHaveLength(0);
  });

  it("records participant status only for the authenticated participant", async () => {
    mocks.takes.set("take-1", {
      id: "take-1",
      sessionId: "s1",
      startedAt: new Date("2026-06-01T12:00:00.000Z"),
      stoppedAt: null,
      status: "recording",
    });
    mocks.resolvePrincipal.mockResolvedValue({
      kind: "guest",
      sessionId: "s1",
      name: "Alice",
      participantId: "guest_alice",
    });

    const res = await reportRecordingState(
      request("PATCH", {
        takeId: "take-1",
        participantId: "host",
        participantName: "Mallory",
        readinessStatus: "ready",
        recordingStatus: "recording",
      }),
      params(),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      participantStatus: {
        takeId: "take-1",
        participantId: "guest_alice",
        participantName: "Alice",
        readinessStatus: "ready",
        recordingStatus: "recording",
      },
    });
    expect(
      mocks.participantStatuses.get("take-1:guest_alice"),
    ).toMatchObject({
      participantId: "guest_alice",
      participantName: "Alice",
    });
    expect(mocks.participantStatuses.has("take-1:host")).toBe(false);
  });

  it("rejects invalid participant readiness and recording statuses", async () => {
    mocks.takes.set("take-1", {
      id: "take-1",
      sessionId: "s1",
      startedAt: new Date("2026-06-01T12:00:00.000Z"),
      stoppedAt: null,
      status: "recording",
    });

    const res = await reportRecordingState(
      request("PATCH", {
        takeId: "take-1",
        readinessStatus: "sure",
        recordingStatus: "maybe_recording",
      }),
      params(),
    );

    expect(res.status).toBe(400);
  });

  it("marks the take stopped (status + timestamp) on host stop", async () => {
    await setRecordingState(
      request("POST", {
        active: true,
        sessionStartedAt: "2026-06-01T12:00:00.000Z",
      }),
      params(),
    );

    const stop = await setRecordingState(
      request("POST", { active: false }),
      params(),
    );
    expect(stop.status).toBe(200);

    const stored = mocks.takes.get("take-1");
    expect(stored?.status).toBe("stopped");
    expect(stored?.stoppedAt).toEqual(expect.any(Date));
  });

  it("does not stop a newer active take when a targeted recovery stop is stale", async () => {
    mocks.takes.set("take-reported", {
      id: "take-reported",
      sessionId: "s1",
      startedAt: new Date("2026-07-08T12:00:00.000Z"),
      stoppedAt: new Date("2026-07-08T12:05:00.000Z"),
      status: "stopped",
    });
    mocks.takes.set("take-newer", {
      id: "take-newer",
      sessionId: "s1",
      startedAt: new Date("2026-07-08T12:10:00.000Z"),
      stoppedAt: null,
      status: "recording",
    });

    const stop = await setRecordingState(
      request("POST", { active: false, takeId: "take-reported" }),
      params(),
    );

    expect(stop.status).toBe(200);
    await expect(stop.json()).resolves.toMatchObject({
      active: true,
      take: { id: "take-newer", status: "recording" },
    });
    expect(mocks.takes.get("take-newer")).toMatchObject({
      status: "recording",
      stoppedAt: null,
    });
  });

  it("waits for the session lock before applying a targeted recovery stop", async () => {
    mocks.takes.set("take-reported", {
      id: "take-reported",
      sessionId: "s1",
      startedAt: new Date("2026-07-08T12:00:00.000Z"),
      stoppedAt: null,
      status: "recording",
    });

    let enterCriticalSection: () => void = () => {};
    const criticalSectionEntered = new Promise<void>((resolve) => {
      enterCriticalSection = resolve;
    });
    let releaseCriticalSection: () => void = () => {};
    const holdCriticalSection = new Promise<void>((resolve) => {
      releaseCriticalSection = resolve;
    });

    // Simulate an initial presign that already read take.status=recording and
    // is paused before creating its track/segment while holding the session
    // advisory lock.
    const presignCriticalSection = withSessionLock("s1", async () => {
      enterCriticalSection();
      await holdCriticalSection;
    });
    await criticalSectionEntered;

    let stopSettled = false;
    const stopPromise = setRecordingState(
      request("POST", { active: false, takeId: "take-reported" }),
      params(),
    ).then((response) => {
      stopSettled = true;
      return response;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const stopSettledWhileLocked = stopSettled;
    const statusWhileLocked = mocks.takes.get("take-reported")?.status;

    releaseCriticalSection();
    await presignCriticalSection;
    const stop = await stopPromise;
    expect(stopSettledWhileLocked).toBe(false);
    expect(statusWhileLocked).toBe("recording");
    expect(stop.status).toBe(200);
    expect(mocks.takes.get("take-reported")?.status).toBe("stopped");
  });

  it("waits for the session lock before applying an untargeted stop", async () => {
    mocks.takes.set("take-active", {
      id: "take-active",
      sessionId: "s1",
      startedAt: new Date("2026-07-08T12:00:00.000Z"),
      stoppedAt: null,
      status: "recording",
    });

    let enterCriticalSection: () => void = () => {};
    const criticalSectionEntered = new Promise<void>((resolve) => {
      enterCriticalSection = resolve;
    });
    let releaseCriticalSection: () => void = () => {};
    const holdCriticalSection = new Promise<void>((resolve) => {
      releaseCriticalSection = resolve;
    });
    const presignCriticalSection = withSessionLock("s1", async () => {
      enterCriticalSection();
      await holdCriticalSection;
    });
    await criticalSectionEntered;

    let stopSettled = false;
    const stopPromise = setRecordingState(
      request("POST", { active: false }),
      params(),
    ).then((response) => {
      stopSettled = true;
      return response;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const stopSettledWhileLocked = stopSettled;
    const statusWhileLocked = mocks.takes.get("take-active")?.status;
    releaseCriticalSection();
    await presignCriticalSection;
    const stop = await stopPromise;

    expect(stopSettledWhileLocked).toBe(false);
    expect(statusWhileLocked).toBe("recording");
    expect(stop.status).toBe(200);
    expect(mocks.takes.get("take-active")?.status).toBe("stopped");
  });

  it("treats status, not stoppedAt, as the active signal", async () => {
    // A take whose stop write landed (status stopped) must never read as active,
    // even though a returning participant might still hold a stale reference.
    mocks.takes.set("take-done", {
      id: "take-done",
      sessionId: "s1",
      startedAt: new Date("2026-06-01T12:00:00.000Z"),
      stoppedAt: new Date("2026-06-01T12:05:00.000Z"),
      status: "stopped",
    });

    const read = await getRecordingState(request("GET"), params());
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      active: false,
      sessionStartedAt: null,
      take: null,
    });
  });

  it("is idempotent when stop is retried after it already landed", async () => {
    await setRecordingState(
      request("POST", {
        active: true,
        sessionStartedAt: "2026-06-01T12:00:00.000Z",
      }),
      params(),
    );

    const first = await setRecordingState(
      request("POST", { active: false }),
      params(),
    );
    const second = await setRecordingState(
      request("POST", { active: false }),
      params(),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      active: false,
      take: null,
    });
    // The already-stopped take is untouched; no second take is created.
    expect(mocks.takes).toHaveLength(1);
    expect(mocks.takes.get("take-1")?.status).toBe("stopped");
  });

  it("starts a fresh take after the previous one was stopped", async () => {
    await setRecordingState(
      request("POST", {
        active: true,
        sessionStartedAt: "2026-06-01T12:00:00.000Z",
      }),
      params(),
    );
    await setRecordingState(request("POST", { active: false }), params());

    const restart = await setRecordingState(
      request("POST", {
        active: true,
        sessionStartedAt: "2026-06-01T12:10:00.000Z",
      }),
      params(),
    );

    expect(restart.status).toBe(200);
    await expect(restart.json()).resolves.toMatchObject({
      active: true,
      sessionStartedAt: "2026-06-01T12:10:00.000Z",
      take: { id: "take-2", status: "recording" },
    });
    expect(mocks.takes).toHaveLength(2);
  });
});
