import { db } from "@/lib/db";
import {
  getObjectBytes,
  listTrackChunkParts,
  putObjectBytes,
  trackRecordingExists,
  trackRecordingKey,
} from "@/lib/s3";

export type RecoveryOutcome =
  | "already_complete"
  | "recovered_from_recording"
  | "recovered_from_chunks"
  | "recovered_partial"
  | "failed_no_chunks";

export interface RecoveryResult {
  trackId: string;
  outcome: RecoveryOutcome;
  partial: boolean;
  status: "complete" | "failed";
  chunkCount: number;
  missingPartNumbers: number[];
}

// Recovery preserves chunk objects in S3 even after producing recording.webm.
// The byte-concat stitch is a best-effort fallback; keeping the chunks gives
// an operator the option to re-stitch manually with ffmpeg if needed.
export async function recoverTrack(trackId: string): Promise<RecoveryResult> {
  const track = await db.track.findUnique({
    where: { id: trackId },
    select: { id: true, sessionId: true, status: true, partial: true },
  });

  if (!track) {
    throw new Error(`Track ${trackId} not found`);
  }

  if (track.status === "complete") {
    return {
      trackId,
      outcome: "already_complete",
      partial: track.partial,
      status: "complete",
      chunkCount: 0,
      missingPartNumbers: [],
    };
  }

  const { sessionId } = track;

  if (await trackRecordingExists(sessionId, trackId)) {
    await db.track.update({
      where: { id: trackId },
      data: {
        status: "complete",
        s3Key: trackRecordingKey(sessionId, trackId),
      },
    });
    return {
      trackId,
      outcome: "recovered_from_recording",
      partial: false,
      status: "complete",
      chunkCount: 0,
      missingPartNumbers: [],
    };
  }

  const parts = await listTrackChunkParts(sessionId, trackId);

  if (parts.length === 0) {
    await db.track.update({
      where: { id: trackId },
      data: { status: "failed" },
    });
    return {
      trackId,
      outcome: "failed_no_chunks",
      partial: false,
      status: "failed",
      chunkCount: 0,
      missingPartNumbers: [],
    };
  }

  const missing: number[] = [];
  const maxPart = parts[parts.length - 1].partNumber;
  const present = new Set(parts.map((p) => p.partNumber));
  for (let i = 0; i <= maxPart; i++) {
    if (!present.has(i)) missing.push(i);
  }
  const partial = missing.length > 0;

  const chunkBytes: Uint8Array[] = [];
  for (const part of parts) {
    chunkBytes.push(await getObjectBytes(part.key));
  }

  const totalBytes = chunkBytes.reduce((sum, b) => sum + b.byteLength, 0);
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const bytes of chunkBytes) {
    merged.set(bytes, offset);
    offset += bytes.byteLength;
  }

  const recordingKey = trackRecordingKey(sessionId, trackId);
  await putObjectBytes(recordingKey, merged);

  await db.track.update({
    where: { id: trackId },
    data: {
      status: "complete",
      s3Key: recordingKey,
      partial,
    },
  });

  if (partial) {
    console.warn(
      `[recovery] track=${trackId} stitched with gaps; missing partNumbers=${missing.join(",")}`
    );
  }

  return {
    trackId,
    outcome: partial ? "recovered_partial" : "recovered_from_chunks",
    partial,
    status: "complete",
    chunkCount: parts.length,
    missingPartNumbers: missing,
  };
}
