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
import {
  createUploadDiagnosticContext,
  recordUploadDiagnostic,
  type UploadDiagnosticContext,
} from "@/lib/upload-diagnostics";

export interface RetryLocalRecordingBackupDeps {
  backupStore?: RecordingBackupStore;
  getPresignedUploadUrl?: typeof getPresignedUploadUrl;
  uploadChunk?: typeof uploadChunk;
  completeUpload?: typeof completeUpload;
  diagnosticContext?: UploadDiagnosticContext;
}

export async function retryLocalRecordingBackupUpload(
  manifest: RecordingBackupManifest,
  deps: RetryLocalRecordingBackupDeps = {},
): Promise<RecordingBackupManifest> {
  const backupStore = deps.backupStore ?? browserRecordingBackupStore;
  const getUploadUrl = deps.getPresignedUploadUrl ?? getPresignedUploadUrl;
  const putChunk = deps.uploadChunk ?? uploadChunk;
  const finishUpload = deps.completeUpload ?? completeUpload;

  // Manifests persisted before segments existed lack segmentId; their
  // recordings belong to the default segment, which shares the track id.
  const segmentId = manifest.segmentId ?? manifest.trackId;
  const context = deps.diagnosticContext ?? createUploadDiagnosticContext({
    sessionId: manifest.sessionId, trackId: manifest.trackId, segmentId,
    kind: "retry", partNumber: 9999, recordingToken: manifest.recordingToken,
  });

  // Preserve the original failure boundary: if this transition fails, do not
  // attempt another storage write that could replace its error.
  await backupStore.markBackupUploading(manifest.id);

  let rebuilt = false;
  try {
    recordUploadDiagnostic(context, { stage: "rebuild", outcome: "started" });
    const recording = await backupStore.buildRecordingBlob(manifest.id);
    rebuilt = true;
    recordUploadDiagnostic(context, { stage: "rebuild", outcome: "succeeded", bytes: recording.size });
    const url = await getUploadUrl(
      manifest.sessionId,
      manifest.trackId,
      9999,
      undefined,
      { segmentId },
      manifest.recordingToken,
      context,
    );
    await putChunk(url, recording, context);
    await finishUpload(
      manifest.sessionId,
      manifest.trackId,
      manifest.durationMs,
      manifest.recordingToken,
      segmentId,
      context,
    );
  } catch (error) {
    if (!rebuilt) recordUploadDiagnostic(context, { stage: "rebuild", outcome: "failed", errorCategory: "storage" });
    recordUploadDiagnostic(context, { stage: "backup", outcome: "retained" });
    await backupStore.markBackupFailed(manifest.id, error);
    throw error;
  }

  return await backupStore.markBackupAvailable(manifest.id, manifest.durationMs);
}
