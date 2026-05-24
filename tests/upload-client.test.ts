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
