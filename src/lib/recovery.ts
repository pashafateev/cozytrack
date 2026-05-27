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
  | "skipped_active"
  | "failed_no_chunks"
  | "failed_too_large";

export interface RecoveryResult {
  trackId: string;
  outcome: RecoveryOutcome;
  partial: boolean;
  status: string;
  chunkCount: number;
  missingPartNumbers: number[];
}

export interface RecoverTrackOptions {
  // Skip chunk-stitching when the newest chunk's S3 LastModified is younger
  // than this. Guards against racing in-flight uploads while the client is
  // still actively writing chunks. Pass undefined to disable the gate.
  chunkStitchMinAgeMs?: number;
  // Hard cap on total chunk bytes materialized in memory during stitch.
  // Exceeding this marks the track failed; chunks remain in S3 for manual
  // ffmpeg recovery.
  maxStitchBytes?: number;
}

const DEFAULT_MAX_STITCH_BYTES = 512 * 1024 * 1024;

// Recovery preserves chunk objects in S3 even after producing recording.webm.
// The byte-concat stitch is a best-effort fallback; keeping the chunks gives
// an operator the option to re-stitch manually with ffmpeg if needed.
export async function recoverTrack(
  trackId: string,
  options: RecoverTrackOptions = {}
): Promise<RecoveryResult> {
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

  // Cheap, race-free signal: if the client uploaded the final blob before
  // its tab died, we can mark the row complete without touching chunks.
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

  // Activity gate: if the newest chunk landed too recently the client is
  // probably still uploading. Stitching now would race the real upload and
  // can mis-flag the track partial (see issue #56 review).
  const minAgeMs = options.chunkStitchMinAgeMs;
  if (minAgeMs !== undefined && minAgeMs > 0) {
    const newest = parts.reduce<Date | undefined>((latest, p) => {
      if (!p.lastModified) return latest;
      if (!latest || p.lastModified > latest) return p.lastModified;
      return latest;
    }, undefined);
    if (newest) {
      const ageMs = Date.now() - newest.getTime();
      if (ageMs < minAgeMs) {
        return {
          trackId,
          outcome: "skipped_active",
          partial: track.partial,
          status: track.status,
          chunkCount: parts.length,
          missingPartNumbers: [],
        };
      }
    }
  }

  const totalSize = parts.reduce((sum, p) => sum + p.size, 0);
  const cap = options.maxStitchBytes ?? DEFAULT_MAX_STITCH_BYTES;
  if (totalSize > cap) {
    console.warn(
      `[recovery] track=${trackId} chunks total ${totalSize} bytes exceeds cap ${cap}; marking failed (chunks preserved)`
    );
    await db.track.update({
      where: { id: trackId },
      data: { status: "failed" },
    });
    return {
      trackId,
      outcome: "failed_too_large",
      partial: false,
      status: "failed",
      chunkCount: parts.length,
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
