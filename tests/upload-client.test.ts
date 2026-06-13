import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeUpload,
  getPresignedUploadTarget,
  getPresignedUploadUrl,
} from "@/lib/upload";
import {
  SYNC_MARKER_DURATION_MS,
  SYNC_MARKER_OFFSET_MS,
  SYNC_MARKER_VERSION,
} from "@/lib/sync-marker";

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

  it("sends sync marker metadata when starting a recording", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ url: "https://s3.example/chunk-0" }),
    );

    await getPresignedUploadTarget("session-1", "track-1", 0, "Alice", {
      syncMarker: {
        version: SYNC_MARKER_VERSION,
        offsetMs: SYNC_MARKER_OFFSET_MS,
        durationMs: SYNC_MARKER_DURATION_MS,
      },
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toMatchObject({
      sessionId: "session-1",
      trackId: "track-1",
      partNumber: 0,
      participantName: "Alice",
      syncMarker: {
        version: SYNC_MARKER_VERSION,
        offsetMs: SYNC_MARKER_OFFSET_MS,
        durationMs: SYNC_MARKER_DURATION_MS,
      },
    });
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
