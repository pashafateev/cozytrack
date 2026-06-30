import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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

  it("gives up after exhausting attempts and throws the last error", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "still down" }, 500));

    await expect(
      stopRecordingTake("s1", { maxAttempts: 3, retryDelayMs: 0 }),
    ).rejects.toBeInstanceOf(RecordingStateError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
