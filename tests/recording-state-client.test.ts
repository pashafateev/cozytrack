import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRecordingTakeState,
  RecordingStateError,
  stopRecordingTake,
} from "@/lib/recording-state";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    json: async () => body,
  } as unknown as Response;
}

const inactiveState = {
  active: false,
  sessionStartedAt: null,
  take: null,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stopRecordingTake durability", () => {
  it("retries a 5xx failure until the stop is confirmed", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, 503))
      .mockResolvedValueOnce(jsonResponse(inactiveState, 200));

    const result = await stopRecordingTake("s1", { retryDelayMs: 0 });

    expect(result).toEqual(inactiveState);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a network/fetch rejection", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(jsonResponse(inactiveState, 200));

    const result = await stopRecordingTake("s1", { retryDelayMs: 0 });

    expect(result).toEqual(inactiveState);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 4xx client error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "forbidden" }, 403));

    await expect(
      stopRecordingTake("s1", { retryDelayMs: 0 }),
    ).rejects.toBeInstanceOf(RecordingStateError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("targets only the unfinished take reported by finalization", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(inactiveState, 200));

    await stopRecordingTake("s1", {
      takeId: "take-from-finalize",
      retryDelayMs: 0,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/s1/recording-state",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          active: false,
          takeId: "take-from-finalize",
        }),
      }),
    );
  });

  it("returns a durable stop immediately and retries pending recovery", async () => {
    const pendingState = {
      active: false,
      sessionStartedAt: null,
      recoveryPending: true,
      take: {
        id: "take-1",
        sessionId: "s1",
        startedAt: "2026-07-25T12:00:00.000Z",
        stoppedAt: "2026-07-25T12:05:00.000Z",
        status: "stopped",
      },
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(pendingState, 200))
      .mockResolvedValueOnce(
        jsonResponse({ ...pendingState, recoveryPending: false }, 200),
      );

    const result = await stopRecordingTake("s1", {
      takeId: "take-1",
      maxAttempts: 3,
      retryDelayMs: 0,
    });

    expect(result).toEqual(pendingState);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/sessions/s1/recording-state",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          active: false,
          takeId: "take-1",
        }),
      }),
    );
  });

  it("retries pending recovery when the stop succeeds on its final attempt", async () => {
    const pendingState = {
      active: false,
      sessionStartedAt: null,
      recoveryPending: true,
      take: {
        id: "take-1",
        sessionId: "s1",
        startedAt: "2026-07-25T12:00:00.000Z",
        stoppedAt: "2026-07-25T12:05:00.000Z",
        status: "stopped",
      },
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "one" }, 503))
      .mockResolvedValueOnce(jsonResponse({ error: "two" }, 503))
      .mockResolvedValueOnce(jsonResponse({ error: "three" }, 503))
      .mockResolvedValueOnce(jsonResponse({ error: "four" }, 503))
      .mockResolvedValueOnce(jsonResponse(pendingState, 200))
      .mockResolvedValueOnce(
        jsonResponse({ ...pendingState, recoveryPending: false }, 200),
      );

    const result = await stopRecordingTake("s1", {
      takeId: "take-1",
      maxAttempts: 5,
      retryDelayMs: 0,
    });

    expect(result).toEqual(pendingState);
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(6);
    });
  });

  it("gives up after exhausting attempts and throws the last error", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "still down" }, 500));

    await expect(
      stopRecordingTake("s1", { maxAttempts: 3, retryDelayMs: 0 }),
    ).rejects.toBeInstanceOf(RecordingStateError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("getRecordingTakeState", () => {
  it("GETs the recording-state endpoint and returns the parsed state", async () => {
    const state = {
      active: true,
      sessionStartedAt: "2026-07-03T09:00:00.000Z",
      take: {
        id: "take-live",
        sessionId: "s1",
        startedAt: "2026-07-03T09:00:00.000Z",
        stoppedAt: null,
        status: "recording",
      },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(state, 200));

    const result = await getRecordingTakeState("s1");

    expect(result).toEqual(state);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/s1/recording-state",
    );
  });

  it("throws a RecordingStateError carrying the HTTP status on failure", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "nope" }, 404));

    await expect(getRecordingTakeState("s1")).rejects.toMatchObject({
      name: "RecordingStateError",
      status: 404,
    });
  });
});
