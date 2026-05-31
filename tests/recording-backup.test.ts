import { describe, expect, it, vi } from "vitest";
import {
  MemoryRecordingBackupBackend,
  RecordingBackupStore,
  type RecordingBackupClearReason,
} from "@/lib/recording-backup";
import { retryLocalRecordingBackupUpload } from "@/lib/recording-backup-upload";

function blob(value: string): Blob {
  return new Blob([value], { type: "audio/webm" });
}

describe("recording backup store", () => {
  it("persists a manifest with chunk upload state and recovery metadata", async () => {
    const store = new RecordingBackupStore(
      new MemoryRecordingBackupBackend(true),
    );

    const manifest = await store.startBackup({
      sessionId: "session-1",
      trackId: "track-1",
      participantName: "Alice",
      recordingToken: "recording-token",
    });

    expect(manifest).toMatchObject({
      id: "session-1:track-1",
      sessionId: "session-1",
      trackId: "track-1",
      participantName: "Alice",
      recordingToken: "recording-token",
      persistentStorage: true,
      state: "recording",
      chunks: [],
    });

    const withChunk = await store.saveChunk({
      sessionId: "session-1",
      trackId: "track-1",
      chunkIndex: 0,
      chunk: blob("first"),
      capturedAt: new Date("2026-05-31T10:00:00.000Z"),
    });

    expect(withChunk.chunks).toEqual([
      expect.objectContaining({
        chunkIndex: 0,
        byteSize: 5,
        capturedAt: "2026-05-31T10:00:00.000Z",
        uploadStatus: "pending",
        storage: "indexeddb",
      }),
    ]);

    const uploaded = await store.markChunkUploaded("session-1", "track-1", 0);
    expect(uploaded.chunks[0]).toMatchObject({
      uploadStatus: "uploaded",
      uploadedAt: expect.any(String),
    });

    await store.saveChunk({
      sessionId: "session-1",
      trackId: "track-1",
      chunkIndex: 1,
      chunk: blob("second"),
    });
    const failed = await store.markChunkFailed(
      "session-1",
      "track-1",
      1,
      new Error("S3 rejected the chunk"),
    );

    expect(failed.state).toBe("failed");
    expect(failed.lastError).toBe("S3 rejected the chunk");
    expect(failed.chunks[1]).toMatchObject({
      uploadStatus: "failed",
      error: "S3 rejected the chunk",
    });
  });

  it("retries a failed remote upload from local chunks", async () => {
    const store = new RecordingBackupStore(
      new MemoryRecordingBackupBackend(true),
    );
    const manifest = await store.startBackup({
      sessionId: "session-1",
      trackId: "track-1",
      participantName: "Alice",
      recordingToken: "recording-token",
    });
    await store.saveChunk({
      sessionId: "session-1",
      trackId: "track-1",
      chunkIndex: 0,
      chunk: blob("first"),
    });
    await store.saveChunk({
      sessionId: "session-1",
      trackId: "track-1",
      chunkIndex: 1,
      chunk: blob("second"),
    });
    const failed = await store.markBackupFailed(
      manifest.id,
      new Error("final upload failed"),
    );

    const getPresignedUploadUrl = vi
      .fn()
      .mockResolvedValue("https://s3.example/final");
    const uploadChunk = vi.fn().mockResolvedValue(undefined);
    const completeUpload = vi.fn().mockResolvedValue(undefined);

    const retried = await retryLocalRecordingBackupUpload(failed, {
      backupStore: store,
      getPresignedUploadUrl,
      uploadChunk,
      completeUpload,
    });

    expect(getPresignedUploadUrl).toHaveBeenCalledWith(
      "session-1",
      "track-1",
      9999,
      undefined,
      undefined,
      "recording-token",
    );
    expect(uploadChunk).toHaveBeenCalledWith(
      "https://s3.example/final",
      expect.any(Blob),
    );
    const uploadedBlob = uploadChunk.mock.calls[0][1] as Blob;
    expect(await uploadedBlob.text()).toBe("firstsecond");
    expect(completeUpload).toHaveBeenCalledWith(
      "session-1",
      "track-1",
      undefined,
      "recording-token",
    );
    expect(retried.state).toBe("available");
    await expect(store.buildRecordingBlob(manifest.id)).resolves.toBeInstanceOf(
      Blob,
    );
  });

  it("clears local chunks only for explicit user or verified-upload cleanup", async () => {
    const store = new RecordingBackupStore(
      new MemoryRecordingBackupBackend(true),
    );
    const manifest = await store.startBackup({
      sessionId: "session-1",
      trackId: "track-1",
      participantName: "Alice",
    });
    await store.saveChunk({
      sessionId: "session-1",
      trackId: "track-1",
      chunkIndex: 0,
      chunk: blob("first"),
    });

    await expect(
      store.clearBackup(
        manifest.id,
        "implicit" as RecordingBackupClearReason,
      ),
    ).rejects.toThrow("explicit reason");
    expect(await store.getBackup(manifest.id)).not.toBeNull();

    await store.clearBackup(manifest.id, "user-confirmed");

    expect(await store.getBackup(manifest.id)).toBeNull();
    await expect(store.buildRecordingBlob(manifest.id)).rejects.toThrow(
      "not found",
    );
  });
});
