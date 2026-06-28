import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeUpload,
  getPresignedUploadTarget,
  getPresignedUploadUrl,
} from "@/lib/upload";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("upload client auth", () => {
  it("returns the recording token from the initial presign response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        url: "https://s3.example/chunk-0",
        recordingToken: "recording-token",
        trackId: "logical-track",
        segmentId: "segment-1",
      }),
    );

    const target = await getPresignedUploadTarget(
      "session-1",
      "track-1",
      0,
      "Alice",
    );

    expect(target).toEqual({
      url: "https://s3.example/chunk-0",
      recordingToken: "recording-token",
      trackId: "logical-track",
      segmentId: "segment-1",
    });
  });

  it("sends the recording token when requesting later chunk presigns", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ url: "https://s3.example/47" }),
    );

    await getPresignedUploadUrl(
      "session-1",
      "track-1",
      47,
      undefined,
      undefined,
      "recording-token",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/upload/presign",
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
          "X-Cozytrack-Recording-Token": "recording-token",
        },
      }),
    );
  });

  it("does not send sync marker metadata when starting a recording", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ url: "https://s3.example/chunk-0" }),
    );

    await getPresignedUploadTarget("session-1", "track-1", 0, "Alice", {
      deviceInfo: {
        deviceLabel: "Shure MV7",
        deviceId: "usb-mic",
        isBuiltInMic: false,
      },
      sessionStartedAt: "2026-06-27T19:42:00.000Z",
      takeId: "take-1",
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      sessionId: "session-1",
      trackId: "track-1",
      partNumber: 0,
      participantName: "Alice",
      deviceLabel: "Shure MV7",
      deviceId: "usb-mic",
      isBuiltInMic: false,
      sessionStartedAt: "2026-06-27T19:42:00.000Z",
      takeId: "take-1",
    });
    expect(body).not.toHaveProperty("syncMarker");
  });

  it("sends the recording token when completing the upload", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "complete" }));

    await completeUpload("session-1", "track-1", 12345, "recording-token");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/upload/complete",
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
          "X-Cozytrack-Recording-Token": "recording-token",
        },
      }),
    );
  });
});
