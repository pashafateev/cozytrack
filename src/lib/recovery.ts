import { db } from "@/lib/db";
import {
  getObjectBytes,
  listTrackChunkParts,
  listTrackSegmentChunkParts,
  putObjectBytes,
  trackRecordingExists,
  trackRecordingKey,
  trackSegmentRecordingExists,
  trackSegmentRecordingKey,
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

  // Segment-aware pass. Until media stitching lands (#111 stack 4) the newest
  // segment whose final recording exists is the track's authoritative
  // artifact; older segments are preserved for the stitcher. Incomplete
  // non-default segments that only have chunk files are not stitched here —
  // their chunks stay in S3 for manual ffmpeg recovery.
  const segments = await db.trackSegment.findMany({
    where: { trackId },
    orderBy: { segmentIndex: "desc" },
    select: { id: true, status: true, createdAt: true },
  });

  // Set when the newest attempt left no recoverable audio: any recovery from
  // older sources must be flagged partial instead of passing the older
  // recording off as the whole take.
  let newerSegmentLost = false;

  if (segments.length > 0) {
    const newest = segments[0];
    const newestRecoverable =
      newest.status === "complete" ||
      (await trackSegmentRecordingExists(sessionId, trackId, newest.id));

    if (!newestRecoverable && newest.id !== trackId) {
      // The newest attempt has no final artifact. Completing the track from
      // older audio would race a participant who is still recording, so only
      // fall back once the attempt shows no recent activity (the default
      // segment is covered by the chunk-stitch gate below).
      const minAgeMs = options.chunkStitchMinAgeMs;
      if (minAgeMs !== undefined && minAgeMs > 0) {
        const newestParts = await listTrackSegmentChunkParts(
          sessionId,
          trackId,
          newest.id
        );
        let lastActivityMs = newest.createdAt.getTime();
        for (const part of newestParts) {
          if (part.lastModified) {
            lastActivityMs = Math.max(
              lastActivityMs,
              part.lastModified.getTime()
            );
          }
        }
        if (Date.now() - lastActivityMs < minAgeMs) {
          return {
            trackId,
            outcome: "skipped_active",
            partial: track.partial,
            status: track.status,
            chunkCount: newestParts.length,
            missingPartNumbers: [],
          };
        }
      }
      newerSegmentLost = true;
    }

    const candidates = newestRecoverable ? [newest] : segments.slice(1);
    for (const segment of candidates) {
      const recovered =
        segment === newest ||
        segment.status === "complete" ||
        (await trackSegmentRecordingExists(sessionId, trackId, segment.id));
      if (!recovered) continue;
      if (segment.status !== "complete") {
        await db.trackSegment.updateMany({
          where: { id: segment.id },
          data: { status: "complete", completedAt: new Date() },
        });
      }
      await db.track.update({
        where: { id: trackId },
        data: {
          status: "complete",
          s3Key: trackSegmentRecordingKey(sessionId, trackId, segment.id),
          partial: newerSegmentLost,
        },
      });
      return {
        trackId,
        outcome: "recovered_from_recording",
        partial: newerSegmentLost,
        status: "complete",
        chunkCount: 0,
        missingPartNumbers: [],
      };
    }
  }

  // Cheap, race-free signal: if the client uploaded the final blob before
  // its tab died, we can mark the row complete without touching chunks.
  // Covers legacy tracks that predate TrackSegment rows.
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
  const partial = missing.length > 0 || newerSegmentLost;

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

  // The stitched chunks belong to the default segment (same id as the track).
  // Keep its row in sync so later segment completions don't see it as
  // forever-pending; updateMany tolerates legacy tracks without segment rows.
  await db.trackSegment.updateMany({
    where: { id: trackId, trackId },
    data: { status: "complete", completedAt: new Date() },
  });

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
