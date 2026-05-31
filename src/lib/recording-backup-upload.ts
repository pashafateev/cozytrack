"use client";

import {
  browserRecordingBackupStore,
  type RecordingBackupManifest,
  type RecordingBackupStore,
} from "@/lib/recording-backup";
import {
  completeUpload,
  getPresignedUploadUrl,
  uploadChunk,
} from "@/lib/upload";

export interface RetryLocalRecordingBackupDeps {
  backupStore?: RecordingBackupStore;
  getPresignedUploadUrl?: typeof getPresignedUploadUrl;
  uploadChunk?: typeof uploadChunk;
  completeUpload?: typeof completeUpload;
}

export async function retryLocalRecordingBackupUpload(
  manifest: RecordingBackupManifest,
  deps: RetryLocalRecordingBackupDeps = {},
): Promise<RecordingBackupManifest> {
  const backupStore = deps.backupStore ?? browserRecordingBackupStore;
  const getUploadUrl = deps.getPresignedUploadUrl ?? getPresignedUploadUrl;
  const putChunk = deps.uploadChunk ?? uploadChunk;
  const finishUpload = deps.completeUpload ?? completeUpload;

  await backupStore.markBackupUploading(manifest.id);

  try {
    const recording = await backupStore.buildRecordingBlob(manifest.id);
    const url = await getUploadUrl(
      manifest.sessionId,
      manifest.trackId,
      9999,
      undefined,
      undefined,
      manifest.recordingToken,
    );
    await putChunk(url, recording);
    await finishUpload(
      manifest.sessionId,
      manifest.trackId,
      manifest.durationMs,
      manifest.recordingToken,
    );
  } catch (error) {
    await backupStore.markBackupFailed(manifest.id, error);
    throw error;
  }

  return await backupStore.markBackupAvailable(manifest.id, manifest.durationMs);
}
