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
  trackSegmentSourceRecordingExists,
  trackSegmentSourceRecordingKey,
} from "@/lib/s3";
import { materializeTrack } from "@/lib/track-materialization";

export type RecoveryOutcome =
  | "already_complete"
  | "recovered_from_recording"
  | "recovered_from_chunks"
  | "recovered_partial"
  | "skipped_active"
  | "failed_no_chunks"
  | "failed_too_large"
  | "failed_materialization";

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
const CHUNK_READ_CONCURRENCY = 8;

type ChunkPart = {
  partNumber: number;
  key: string;
  size: number;
  lastModified?: Date;
};

type MergedChunkParts =
  | {
      ok: true;
      bytes: Uint8Array;
      missingPartNumbers: number[];
    }
  | {
      ok: false;
      totalSize: number;
    };

async function mergeChunkParts(
  parts: ChunkPart[],
  maxStitchBytes?: number,
): Promise<MergedChunkParts> {
  const totalSize = parts.reduce((sum, part) => sum + part.size, 0);
  const cap = maxStitchBytes ?? DEFAULT_MAX_STITCH_BYTES;
  if (totalSize > cap) {
    return { ok: false, totalSize };
  }

  const missingPartNumbers: number[] = [];
  const maxPart = parts[parts.length - 1].partNumber;
  const present = new Set(parts.map((part) => part.partNumber));
  for (let partNumber = 0; partNumber <= maxPart; partNumber += 1) {
    if (!present.has(partNumber)) missingPartNumbers.push(partNumber);
  }

  const chunkBytes: Uint8Array[] = [];
  for (
    let start = 0;
    start < parts.length;
    start += CHUNK_READ_CONCURRENCY
  ) {
    const batch = await Promise.all(
      parts
        .slice(start, start + CHUNK_READ_CONCURRENCY)
        .map((part) => getObjectBytes(part.key)),
    );
    // Promise.all preserves input order, and batches are appended in part
    // order, so the merged WebM remains deterministic while S3 latency is
    // amortized across a bounded number of requests.
    chunkBytes.push(...batch);
  }

  const totalBytes = chunkBytes.reduce(
    (sum, bytes) => sum + bytes.byteLength,
    0,
  );
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const bytes of chunkBytes) {
    merged.set(bytes, offset);
    offset += bytes.byteLength;
  }

  return {
    ok: true,
    bytes: merged,
    missingPartNumbers,
  };
}

// Byte-concats a segment's chunk objects into its recording key and marks the
// segment and track complete. Chunks are preserved in S3 for manual ffmpeg
// re-stitching. `forcePartial` flags the track partial even without chunk
// gaps, for when a newer attempt's audio is known to be unrecoverable.
async function stitchSegmentChunks(input: {
  sessionId: string;
  trackId: string;
  segmentId: string;
  parts: ChunkPart[];
  maxStitchBytes?: number;
  forcePartial: boolean;
}): Promise<RecoveryResult> {
  const { sessionId, trackId, segmentId, parts, forcePartial } = input;

  const merged = await mergeChunkParts(parts, input.maxStitchBytes);
  if (!merged.ok) {
    console.warn(
      `[recovery] track=${trackId} chunks total ${merged.totalSize} bytes exceeds cap ${
        input.maxStitchBytes ?? DEFAULT_MAX_STITCH_BYTES
      }; marking failed (chunks preserved)`
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

  const missing = merged.missingPartNumbers;
  const partial = missing.length > 0 || forcePartial;

  if (partial) {
    // Make partialness durable before any S3, segment, or materialization
    // failure can make a retry skip the gap that established it.
    await db.track.update({
      where: { id: trackId },
      data: { partial: true },
    });
  }

  const recordingKey = trackSegmentRecordingKey(sessionId, trackId, segmentId);
  await putObjectBytes(recordingKey, merged.bytes);

  // Keep the segment row in sync so later segment completions don't see it
  // as forever-pending; updateMany tolerates legacy tracks without rows.
  await db.trackSegment.updateMany({
    where: { id: segmentId, trackId },
    data: { status: "complete", completedAt: new Date() },
  });

  const materialized = await materializeTrack(trackId, {
    partial,
    skipMissingSegments: true,
    ...(forcePartial ? { allowIncompleteLatest: true } : {}),
  });
  if (materialized.status !== "complete") {
    return {
      trackId,
      outcome: "failed_materialization",
      partial,
      status: materialized.status,
      chunkCount: parts.length,
      missingPartNumbers: missing,
    };
  }

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

export interface InterruptedTrackSegmentRecoveryResult {
  recoveredSegmentIds: string[];
  partial: boolean;
}

// A later segment completing after the take is authoritatively stopped proves
// that older attempts for the same participant are no longer active. Recover
// any chunk-backed older attempts into immutable per-segment sources before
// the caller materializes the logical track once.
export async function recoverInterruptedTrackSegments(
  trackId: string,
  beforeSegmentIndex: number,
  options: Pick<RecoverTrackOptions, "maxStitchBytes"> = {},
): Promise<InterruptedTrackSegmentRecoveryResult> {
  const track = await db.track.findUnique({
    where: { id: trackId },
    select: { id: true, sessionId: true, partial: true },
  });
  if (!track) {
    throw new Error(`Track ${trackId} not found`);
  }

  const segments = await db.trackSegment.findMany({
    where: { trackId },
    orderBy: { segmentIndex: "asc" },
    select: {
      id: true,
      status: true,
      segmentIndex: true,
    },
  });
  const interrupted = segments.filter(
    (segment) =>
      segment.segmentIndex < beforeSegmentIndex &&
      segment.status !== "complete" &&
      segment.status !== "failed",
  );

  const recoveredSegmentIds: string[] = [];
  let partial = track.partial;
  const persistPartial = async () => {
    if (partial) return;
    await db.track.update({
      where: { id: trackId },
      data: { partial: true },
    });
    partial = true;
  };

  for (const segment of interrupted) {
    const sourceKey = trackSegmentSourceRecordingKey(
      track.sessionId,
      trackId,
      segment.id,
    );
    let sourceReady = await trackSegmentSourceRecordingExists(
      track.sessionId,
      trackId,
      segment.id,
    );

    if (!sourceReady) {
      const parts = await listTrackSegmentChunkParts(
        track.sessionId,
        trackId,
        segment.id,
      );
      if (parts.length === 0) continue;

      const merged = await mergeChunkParts(parts, options.maxStitchBytes);
      if (!merged.ok) {
        await persistPartial();
        console.warn(
          `[recovery] track=${trackId} interrupted segment=${segment.id} chunks total ${merged.totalSize} bytes exceeds cap ${
            options.maxStitchBytes ?? DEFAULT_MAX_STITCH_BYTES
          }; marking track partial and leaving chunks recoverable`,
        );
        continue;
      }

      if (merged.missingPartNumbers.length > 0) {
        // Persist the gap before writing the immutable source. If a later S3,
        // database, or materialization step fails, retry must retain the
        // partial marker after this segment becomes complete.
        await persistPartial();
      }
      await putObjectBytes(sourceKey, merged.bytes);
      sourceReady = true;
    }

    if (!sourceReady) continue;
    const updated = await db.trackSegment.updateMany({
      where: {
        id: segment.id,
        trackId,
        status: { notIn: ["complete", "failed"] },
      },
      data: { status: "complete", completedAt: new Date() },
    });
    if (updated.count > 0) {
      recoveredSegmentIds.push(segment.id);
    }
  }

  return { recoveredSegmentIds, partial };
}

// A participant can finish its replacement segment before the host stops the
// take. Upload completion cannot recover older attempts while the take is
// active, so the authoritative stop transition provides the second trigger.
// Re-running this after a failed stop response is safe: already recovered
// segments are skipped, while failed materialization remains retryable.
export async function recoverStoppedTakeTracks(
  takeId: string,
): Promise<string[]> {
  const tracks = await db.track.findMany({
    where: { takeId },
    select: {
      id: true,
      status: true,
      segments: {
        orderBy: { segmentIndex: "asc" },
        select: {
          id: true,
          status: true,
          segmentIndex: true,
        },
      },
    },
  });
  const rematerializedTrackIds: string[] = [];

  for (const track of tracks) {
    const latestSegment = track.segments[track.segments.length - 1];
    if (!latestSegment || latestSegment.status !== "complete") continue;

    const hasInterruptedOlderSegment = track.segments.some(
      (segment) =>
        segment.segmentIndex < latestSegment.segmentIndex &&
        segment.status !== "complete" &&
        segment.status !== "failed",
    );
    let recovered: InterruptedTrackSegmentRecoveryResult = {
      recoveredSegmentIds: [],
      partial: false,
    };
    if (hasInterruptedOlderSegment) {
      // Invalidate an already-complete logical artifact before changing any
      // segment to complete. If recovery or remuxing then fails (or the
      // process exits between those steps), the next stop retry sees a
      // non-complete track and rematerializes instead of trusting the old,
      // truncated artifact.
      await db.track.updateMany({
        where: { id: track.id, status: "complete" },
        data: { status: "uploading" },
      });
      recovered = await recoverInterruptedTrackSegments(
        track.id,
        latestSegment.segmentIndex,
      );
    }

    const shouldMaterialize =
      hasInterruptedOlderSegment ||
      recovered.recoveredSegmentIds.length > 0 ||
      recovered.partial ||
      track.status !== "complete";
    if (!shouldMaterialize) continue;

    const materialized = await materializeTrack(
      track.id,
      recovered.partial ? { partial: true } : {},
    );
    if (materialized.status !== "complete") {
      throw new Error(
        `Stopped take ${takeId} failed to materialize track ${track.id}: ${materialized.status}`,
      );
    }
    rematerializedTrackIds.push(track.id);
  }

  return rematerializedTrackIds;
}

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
  // segment with recoverable audio is the track's authoritative artifact;
  // older segments are preserved for the stitcher.
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

    if (!newestRecoverable) {
      const newestParts = await listTrackSegmentChunkParts(
        sessionId,
        trackId,
        newest.id
      );

      // The newest attempt has no final artifact. Recovering anything —
      // stitching its chunks or falling back to older audio — must not race
      // a participant who is still recording, so check for recent activity
      // first (segment row age plus chunk upload times).
      const minAgeMs = options.chunkStitchMinAgeMs;
      if (minAgeMs !== undefined && minAgeMs > 0) {
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

      if (newestParts.length > 0) {
        // The tab died after uploading chunks but before the final blob —
        // those chunks are the newest attempt's authoritative audio.
        return await stitchSegmentChunks({
          sessionId,
          trackId,
          segmentId: newest.id,
          parts: newestParts,
          maxStitchBytes: options.maxStitchBytes,
          forcePartial: false,
        });
      }

      if (newest.id !== trackId) {
        newerSegmentLost = true;
      }
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
      if (newerSegmentLost && !track.partial) {
        await db.track.update({
          where: { id: trackId },
          data: { partial: true },
        });
      }
      const partial = track.partial || newerSegmentLost;
      const materialized = await materializeTrack(trackId, {
        partial,
        skipMissingSegments: true,
        ...(newerSegmentLost ? { allowIncompleteLatest: true } : {}),
      });
      if (materialized.status !== "complete") {
        return {
          trackId,
          outcome: "failed_materialization",
          partial,
          status: materialized.status,
          chunkCount: 0,
          missingPartNumbers: [],
        };
      }
      return {
        trackId,
        outcome: "recovered_from_recording",
        partial,
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
      partial: track.partial,
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

  // The stitched chunks belong to the default segment (same id as the track).
  return await stitchSegmentChunks({
    sessionId,
    trackId,
    segmentId: trackId,
    parts,
    maxStitchBytes: options.maxStitchBytes,
    forcePartial: newerSegmentLost,
  });
}
