import { afterEach, describe, it, expect, beforeEach, vi } from "vitest";

type RecordingTake = {
  id: string;
  sessionId: string;
  startedAt: Date;
  stoppedAt: Date | null;
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

const mocks = vi.hoisted(() => ({
  sessions: new Set<string>(),
  takes: new Map<string, RecordingTake>(),
  participantStatuses: new Map<string, RecordingTakeParticipantStatus>(),
  resolvePrincipal: vi.fn(),
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
      (take) => take.sessionId === sessionId && take.stoppedAt === null,
    ) ?? null
  );
}

vi.mock("@/lib/db", () => ({
  db: {
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
          where: { sessionId: string; stoppedAt?: null };
        }) => {
          let take: RecordingTake | null = null;
          if (where.stoppedAt === null) {
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
          data: { sessionId: string; startedAt: Date };
        }) => {
          const take: RecordingTake = {
            id: `take-${mocks.nextTakeId++}`,
            sessionId: data.sessionId,
            startedAt: data.startedAt,
            stoppedAt: null,
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
          data: { stoppedAt?: Date | null };
        }) => {
          const take = mocks.takes.get(id);
          if (!take) throw new Error("take not found");
          const updated = { ...take, ...data };
          mocks.takes.set(id, updated);
          return cloneTake(updated);
        },
      ),
    },
    recordingTakeParticipantStatus: {
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
  },
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
import {
  GET as getRecordingState,
  PATCH as reportRecordingState,
  POST as setRecordingState,
} from "@/app/api/sessions/[id]/recording-state/route";

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
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-01T12:06:00.000Z"));
  mocks.sessions.clear();
  mocks.takes.clear();
  mocks.participantStatuses.clear();
  mocks.sessions.add("s1");
  mocks.nextTakeId = 1;
  vi.clearAllMocks();
  mocks.resolvePrincipal.mockResolvedValue({
    kind: "host",
    participantId: "host",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("/api/sessions/[id]/recording-state", () => {
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

  it("expires an active take after ten minutes with no participant heartbeat", async () => {
    const staleStartedAt = new Date(Date.now() - 11 * 60 * 1000);
    mocks.takes.set("take-1", {
      id: "take-1",
      sessionId: "s1",
      startedAt: staleStartedAt,
      stoppedAt: null,
    });

    const read = await getRecordingState(request("GET"), params());

    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      active: false,
      sessionStartedAt: null,
      take: null,
    });
    expect(mocks.takes.get("take-1")?.stoppedAt).toEqual(expect.any(Date));
  });

  it("keeps an active take fresh when a participant heartbeat is recent", async () => {
    const staleStartedAt = new Date(Date.now() - 11 * 60 * 1000);
    mocks.takes.set("take-1", {
      id: "take-1",
      sessionId: "s1",
      startedAt: staleStartedAt,
      stoppedAt: null,
    });
    mocks.participantStatuses.set("take-1:guest_alice", {
      takeId: "take-1",
      participantId: "guest_alice",
      participantName: "Alice",
      readinessStatus: null,
      recordingStatus: "recording",
      statusReason: null,
      updatedAt: new Date(),
    });

    const read = await getRecordingState(request("GET"), params());

    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      active: true,
      take: { id: "take-1" },
    });
    expect(mocks.takes.get("take-1")?.stoppedAt).toBeNull();
  });

  it("starts a new take when the active take has a host stopped status", async () => {
    mocks.takes.set("take-old", {
      id: "take-old",
      sessionId: "s1",
      startedAt: new Date("2026-06-01T12:00:00.000Z"),
      stoppedAt: null,
    });
    mocks.participantStatuses.set("take-old:host", {
      takeId: "take-old",
      participantId: "host",
      participantName: null,
      readinessStatus: null,
      recordingStatus: "connected",
      statusReason: null,
      updatedAt: new Date(),
    });

    const start = await setRecordingState(
      request("POST", {
        active: true,
        sessionStartedAt: "2026-06-01T12:06:00.000Z",
      }),
      params(),
    );

    expect(start.status).toBe(200);
    await expect(start.json()).resolves.toMatchObject({
      active: true,
      sessionStartedAt: "2026-06-01T12:06:00.000Z",
      take: { id: "take-1", stoppedAt: null },
    });
    expect(mocks.takes.get("take-old")?.stoppedAt).toEqual(expect.any(Date));
    expect(mocks.takes.get("take-1")?.stoppedAt).toBeNull();
  });

  it("does not expire a take from another session when reporting by takeId", async () => {
    const staleStartedAt = new Date(Date.now() - 11 * 60 * 1000);
    mocks.takes.set("take-other", {
      id: "take-other",
      sessionId: "s2",
      startedAt: staleStartedAt,
      stoppedAt: null,
    });

    const res = await reportRecordingState(
      request("PATCH", {
        takeId: "take-other",
        recordingStatus: "recording",
      }),
      params("s1"),
    );

    expect(res.status).toBe(403);
    expect(mocks.takes.get("take-other")?.stoppedAt).toBeNull();
    expect(mocks.participantStatuses).toHaveLength(0);
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
});
