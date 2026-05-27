import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  consoleError: vi.spyOn(console, "error").mockImplementation(() => {}),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(function S3Client() {
    return { send: mocks.send };
  }),
  PutObjectCommand: vi.fn(function PutObjectCommand(input) {
    return { input, type: "PutObjectCommand" };
  }),
  GetObjectCommand: vi.fn(function GetObjectCommand(input) {
    return { input, type: "GetObjectCommand" };
  }),
  ListObjectsV2Command: vi.fn(function ListObjectsV2Command(input) {
    return { input, type: "ListObjectsV2Command" };
  }),
  DeleteObjectsCommand: vi.fn(function DeleteObjectsCommand(input) {
    return { input, type: "DeleteObjectsCommand" };
  }),
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(),
}));

import { deleteSessionObjects, deleteTrackChunks } from "@/lib/s3";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("S3 deletion helpers", () => {
  it("keeps track chunk cleanup best-effort when S3 delete reports errors", async () => {
    mocks.send
      .mockResolvedValueOnce({
        Contents: [
          { Key: "sessions/s1/tracks/t1/1.webm" },
          { Key: "sessions/s1/tracks/t1/recording.webm" },
        ],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({
        Errors: [{ Key: "sessions/s1/tracks/t1/1.webm" }],
      });

    await expect(deleteTrackChunks("s1", "t1")).resolves.toBeUndefined();
    expect(mocks.consoleError).toHaveBeenCalledWith(
      "Failed to delete track chunks:",
      expect.any(Error),
    );
  });

  it("keeps session purge deletion strict when S3 delete reports errors", async () => {
    mocks.send
      .mockResolvedValueOnce({
        Contents: [{ Key: "sessions/s1/tracks/t1/recording.webm" }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({
        Errors: [{ Key: "sessions/s1/tracks/t1/recording.webm" }],
      });

    await expect(deleteSessionObjects("s1")).rejects.toThrow(
      "Failed to delete S3 objects: sessions/s1/tracks/t1/recording.webm",
    );
  });
});
