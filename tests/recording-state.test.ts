import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: {
    id: "s1",
    activeRecordingStartedAt: null as Date | null,
  },
  resolvePrincipal: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    session: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) =>
        id === mocks.session.id ? { ...mocks.session } : null,
      ),
      update: vi.fn(
        async ({
          where: { id },
          data,
        }: {
          where: { id: string };
          data: { activeRecordingStartedAt: Date | null };
        }) => {
          if (id !== mocks.session.id) throw new Error("not found");
          mocks.session.activeRecordingStartedAt = data.activeRecordingStartedAt;
          return { ...mocks.session };
        },
      ),
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  resolvePrincipal: mocks.resolvePrincipal,
}));

import { NextRequest } from "next/server";
import {
  GET as getRecordingState,
  POST as setRecordingState,
} from "@/app/api/sessions/[id]/recording-state/route";

function params(id = "s1") {
  return { params: Promise.resolve({ id }) };
}

function request(body?: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/sessions/s1/recording-state", {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  mocks.session.activeRecordingStartedAt = null;
  vi.clearAllMocks();
  mocks.resolvePrincipal.mockResolvedValue({ kind: "host" });
});

describe("/api/sessions/[id]/recording-state", () => {
  it("lets hosts mark and clear an active room recording", async () => {
    const startedAt = "2026-06-01T12:00:00.000Z";

    const mark = await setRecordingState(
      request({ active: true, sessionStartedAt: startedAt }),
      params(),
    );
    expect(mark.status).toBe(200);
    await expect(mark.json()).resolves.toEqual({
      active: true,
      sessionStartedAt: startedAt,
    });

    const read = await getRecordingState(request(), params());
    await expect(read.json()).resolves.toEqual({
      active: true,
      sessionStartedAt: startedAt,
    });

    const clear = await setRecordingState(request({ active: false }), params());
    expect(clear.status).toBe(200);
    await expect(clear.json()).resolves.toEqual({
      active: false,
      sessionStartedAt: null,
    });
  });

  it("allows guests to read but not mutate recording state", async () => {
    mocks.resolvePrincipal.mockResolvedValue({
      kind: "guest",
      sessionId: "s1",
      name: "Alice",
    });

    const read = await getRecordingState(request(), params());
    expect(read.status).toBe(200);

    const write = await setRecordingState(
      request({ active: true, sessionStartedAt: "2026-06-01T12:00:00.000Z" }),
      params(),
    );
    expect(write.status).toBe(403);
  });

  it("rejects active updates without a valid start time", async () => {
    const res = await setRecordingState(
      request({ active: true, sessionStartedAt: "not-a-date" }),
      params(),
    );

    expect(res.status).toBe(400);
  });
});
