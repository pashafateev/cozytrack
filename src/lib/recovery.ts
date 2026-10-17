import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { logServerUploadDiagnostic } from "@/lib/upload-diagnostics-server";
import type { UploadDiagnosticEvent } from "@/lib/upload-diagnostic-event";
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

  const attemptId = randomUUID();
  for (const segment of interrupted) {
    const startedAt = Date.now();
    const log = (
      outcome: UploadDiagnosticEvent["outcome"],
      details: { bytes?: number; recoveryOutcome?: RecoveryOutcome; errorCategory?: "unknown" } = {},
    ) => logServerUploadDiagnostic({
      attemptId, sessionId: track.sessionId, trackId, segmentId: segment.id,
      kind: "retry", stage: "recovery", outcome, partial,
      elapsedMs: Date.now() - startedAt, ...details,
    });
    log("started");
    try {
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

      const usedExistingSource = sourceReady;
      let recoveredBytes: number | undefined;

      if (!sourceReady) {
        const parts = await listTrackSegmentChunkParts(
          track.sessionId,
          trackId,
          segment.id,
        );
        if (parts.length === 0) {
          log("unknown", { bytes: 0 });
          continue;
        }

        const merged = await mergeChunkParts(parts, options.maxStitchBytes);
        if (!merged.ok) {
          await persistPartial();
          console.warn(
            `[recovery] track=${trackId} interrupted segment=${segment.id} chunks total ${merged.totalSize} bytes exceeds cap ${
              options.maxStitchBytes ?? DEFAULT_MAX_STITCH_BYTES
            }; marking track partial and leaving chunks recoverable`,
          );
          log("retained", { bytes: merged.totalSize, recoveryOutcome: "failed_too_large" });
          continue;
        }

        if (merged.missingPartNumbers.length > 0) {
          // Persist the gap before writing the immutable source. If a later S3,
          // database, or materialization step fails, retry must retain the
          // partial marker after this segment becomes complete.
          await persistPartial();
        }
        await putObjectBytes(sourceKey, merged.bytes);
        recoveredBytes = merged.bytes.byteLength;
        sourceReady = true;
      }

      if (!sourceReady) {
        log("unknown");
        continue;
      }
      // Once another completed segment will be added to the source set, the
      // existing logical artifact is stale. Invalidate it before committing the
      // segment transition so a crash or remux failure leaves a durable retry
      // signal for either upload completion or stopped-take recovery.
      await db.track.updateMany({
        where: { id: trackId, status: "complete" },
        data: { status: "uploading" },
      });
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
        log(usedExistingSource ? "already_exists" : "succeeded", {
          bytes: recoveredBytes,
          recoveryOutcome: usedExistingSource ? "recovered_from_recording" : "recovered_from_chunks",
        });
      } else {
        log("unknown");
      }
    } catch (error) {
      log("failed", { errorCategory: "unknown" });
      throw error;
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
      sessionId: true,
      status: true,
      partial: true,
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
  const attemptId = randomUUID();

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

    const startedAt = Date.now();
    const log = (
      outcome: UploadDiagnosticEvent["outcome"],
      details: { materializationStatus?: Awaited<ReturnType<typeof materializeTrack>>["status"]; errorCategory?: "unknown" } = {},
    ) => logServerUploadDiagnostic({
      attemptId, sessionId: track.sessionId, trackId: track.id,
      segmentId: latestSegment.id, kind: "retry", stage: "materialize", outcome,
      partial: track.partial || recovered.partial, elapsedMs: Date.now() - startedAt, ...details,
    });
    log("started");
    let materialized;
    try {
      materialized = await materializeTrack(
        track.id,
        recovered.partial ? { partial: true } : {},
      );
    } catch (error) {
      log("failed", { errorCategory: "unknown" });
      throw error;
    }
    log(materialized.status === "complete" ? "succeeded" : "failed", {
      materializationStatus: materialized.status,
    });
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
  const attemptId = randomUUID();
  const startedAt = Date.now();
  const scope: { sessionId?: string; segmentId?: string } = {};
  const log = (outcome: UploadDiagnosticEvent["outcome"], result?: RecoveryResult) => {
    if (!scope.sessionId) return;
    logServerUploadDiagnostic({
      attemptId, sessionId: scope.sessionId, trackId, segmentId: scope.segmentId,
      kind: "retry", stage: "recovery", outcome, elapsedMs: Date.now() - startedAt,
      ...(result ? {
        recoveryOutcome: result.outcome, partial: result.partial,
        trackStatus: result.status as UploadDiagnosticEvent["trackStatus"],
      } : outcome === "failed" ? { errorCategory: "unknown" as const } : {}),
    });
  };
  try {
    const result = await recoverTrackInternal(trackId, options, (sessionId, segmentId) => {
      const first = !scope.sessionId;
      scope.sessionId = sessionId;
      scope.segmentId = segmentId;
      if (first) log("started");
    });
    log(result.outcome === "already_complete" ? "already_exists" :
      result.outcome === "skipped_active" ? "unknown" :
        result.outcome.startsWith("failed_") ? "failed" : "succeeded", result);
    return result;
  } catch (error) {
    log("failed");
    throw error;
  }
}

async function recoverTrackInternal(
  trackId: string,
  options: RecoverTrackOptions,
  setDiagnosticScope: (sessionId: string, segmentId?: string) => void,
): Promise<RecoveryResult> {
  const track = await db.track.findUnique({
    where: { id: trackId },
    select: { id: true, sessionId: true, status: true, partial: true },
  });

  if (!track) {
    throw new Error(`Track ${trackId} not found`);
  }
  setDiagnosticScope(track.sessionId);

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
    setDiagnosticScope(sessionId, newest.id);
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
      setDiagnosticScope(sessionId, segment.id);
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
  setDiagnosticScope(sessionId, trackId);
  return await stitchSegmentChunks({
    sessionId,
    trackId,
    segmentId: trackId,
    parts,
    maxStitchBytes: options.maxStitchBytes,
    forcePartial: newerSegmentLost,
  });
}
