import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ffmpegStaticPath from "ffmpeg-static";
import { db } from "@/lib/db";
import {
  detectSyncMarkerInWebmBytes,
  markerInfo,
  type SyncMarkerDetectionResult,
} from "@/lib/sync-marker-detection";
import {
  getObjectBytes,
  getObjectBytesRange,
  putObjectBytes,
  trackRecordingKey,
  trackSegmentRecordingExists,
  trackSegmentRecordingKey,
  trackSegmentSourceRecordingExists,
  trackSegmentSourceRecordingKey,
} from "@/lib/s3";

const execFileAsync = promisify(execFile);

type CompletedSegment = {
  id: string;
  segmentIndex: number;
  status: string;
  durationMs: number | null;
  syncMarkerVersion: string | null;
};

export type MaterializationStatus =
  | "complete"
  | "pending"
  | "failed"
  | "superseded";

export type MaterializationResult = {
  trackId: string;
  status: MaterializationStatus;
  s3Key: string;
  segmentCount: number;
  durationMs: number | null;
};

export type RemuxSegmentsInput = {
  sourceKeys: string[];
  outputKey: string;
};

export type MaterializeTrackDeps = {
  readObjectBytes?: (key: string) => Promise<Uint8Array>;
  readObjectBytesRange?: (key: string, maxBytes: number) => Promise<Uint8Array>;
  writeObjectBytes?: (key: string, bytes: Uint8Array) => Promise<void>;
  remuxSegments?: (input: RemuxSegmentsInput) => Promise<void>;
  detectSyncMarker?: (
    input: DetectSyncMarkerInput,
  ) => Promise<SyncMarkerDetectionResult>;
  detectionTimeoutMs?: number;
  partial?: boolean;
  allowIncompleteLatest?: boolean;
  skipMissingSegments?: boolean;
};

export type DetectSyncMarkerInput = {
  sessionId: string;
  trackId: string;
  segmentId: string;
  sourceKey: string;
};

async function segmentRecordingKeys(
  sessionId: string,
  trackId: string,
  segments: CompletedSegment[],
  deps: Required<
    Pick<MaterializeTrackDeps, "readObjectBytes" | "writeObjectBytes">
  >,
): Promise<string[]> {
  const keys: string[] = [];
  for (const segment of segments) {
    if (segment.id !== trackId) {
      keys.push(trackSegmentRecordingKey(sessionId, trackId, segment.id));
      continue;
    }

    const sourceKey = trackSegmentSourceRecordingKey(
      sessionId,
      trackId,
      segment.id,
    );
    if (
      !(await trackSegmentSourceRecordingExists(sessionId, trackId, segment.id))
    ) {
      // The default segment originally uploads to the logical output key.
      // Preserve that raw source before remuxing overwrites the logical file.
      await deps.writeObjectBytes(
        sourceKey,
        await deps.readObjectBytes(
          trackSegmentRecordingKey(sessionId, trackId, segment.id),
        ),
      );
    }
    keys.push(sourceKey);
  }
  return keys;
}

function totalDurationMs(segments: CompletedSegment[]): number | null {
  if (segments.some((segment) => segment.durationMs === null)) {
    return null;
  }
  return segments.reduce((total, segment) => total + segment.durationMs!, 0);
}

function concatListLine(filePath: string): string {
  return `file '${filePath.replace(/'/g, "'\\''")}'`;
}

async function remuxWebmSegments(
  input: RemuxSegmentsInput,
  deps: Required<Pick<MaterializeTrackDeps, "readObjectBytes" | "writeObjectBytes">>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "cozytrack-materialize-"));

  try {
    const inputPaths: string[] = [];
    for (const [index, sourceKey] of input.sourceKeys.entries()) {
      const inputPath = join(dir, `${index}.webm`);
      await writeFile(inputPath, await deps.readObjectBytes(sourceKey));
      inputPaths.push(inputPath);
    }

    const listPath = join(dir, "segments.txt");
    const outputPath = join(dir, "recording.webm");
    await writeFile(
      listPath,
      `${inputPaths.map(concatListLine).join("\n")}\n`,
    );

    await execFileAsync(
      process.env.FFMPEG_PATH ?? ffmpegStaticPath ?? "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-c",
        "copy",
        outputPath,
      ],
    );

    await deps.writeObjectBytes(input.outputKey, await readFile(outputPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Detection only inspects the first ~5.3s, and ffmpeg's `-t` cap stops decoding
// before reaching the end of this slice for any realistic Opus bitrate (Opus
// tops out near 510kbps; 4 MiB holds >60s at that rate). Reading a bounded
// range instead of the whole object keeps an arbitrarily large upload from
// being downloaded and buffered into /tmp just to look at its start.
const DETECTION_SOURCE_READ_MAX_BYTES = 4 * 1024 * 1024;

async function detectSegmentSyncMarker(
  input: DetectSyncMarkerInput,
  deps: Required<Pick<MaterializeTrackDeps, "readObjectBytesRange">>,
): Promise<SyncMarkerDetectionResult> {
  const bytes = await deps.readObjectBytesRange(
    input.sourceKey,
    DETECTION_SOURCE_READ_MAX_BYTES,
  );
  return await detectSyncMarkerInWebmBytes(bytes);
}

async function persistSegmentSyncMarkerDetection(input: {
  segmentId: string;
  result: SyncMarkerDetectionResult;
}) {
  const { segmentId, result } = input;
  await db.trackSegment.update({
    where: { id: segmentId },
    data: {
      syncMarkerDetectionStatus: result.status,
      syncMarkerDetectedAtMs: result.detectedAtMs,
      syncMarkerDetectedAtSamples: result.detectedAtSamples,
      syncMarkerConfidence: result.confidence,
      syncMarkerAnalyzedAt: new Date(),
    },
  });
}

async function markSyncMarkerSourceMissing(segmentId: string) {
  await persistSegmentSyncMarkerDetection({
    segmentId,
    result: {
      status: "source_missing",
      detectedAtMs: null,
      detectedAtSamples: null,
      confidence: 0,
      marker: markerInfo(),
    },
  });
}

// Detection decodes each segment with ffmpeg, so bound how many run at once to
// avoid spiking memory and /tmp usage on tracks with many marker segments.
const SYNC_MARKER_DETECTION_CONCURRENCY = 2;

// Upper bound on a single segment's detection. The ffmpeg decode has its own
// inner timeout; this is a backstop covering any other hang so detection can't
// stall the upload-completion request that awaits materializeTrack.
const SYNC_MARKER_DETECTION_TIMEOUT_MS = 20000;

class SyncMarkerDetectionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`sync-marker detection timed out after ${timeoutMs}ms`);
    this.name = "SyncMarkerDetectionTimeoutError";
  }
}

async function withDetectionTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new SyncMarkerDetectionTimeoutError(timeoutMs)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function detectAndPersistOneSegment(input: {
  sessionId: string;
  trackId: string;
  segment: CompletedSegment;
  sourceKey: string;
  detectSyncMarker: (input: DetectSyncMarkerInput) => Promise<SyncMarkerDetectionResult>;
  timeoutMs: number;
}) {
  const { sessionId, trackId, segment, sourceKey, detectSyncMarker, timeoutMs } =
    input;
  try {
    const result = await withDetectionTimeout(
      detectSyncMarker({
        sessionId,
        trackId,
        segmentId: segment.id,
        sourceKey,
      }),
      timeoutMs,
    );
    await persistSegmentSyncMarkerDetection({ segmentId: segment.id, result });
  } catch (error) {
    console.error(
      `[sync-marker] segment=${segment.id} detection failed:`,
      error,
    );
    // Best-effort: record the failure, but never let a metadata write reject
    // the materialization that already completed successfully.
    try {
      await persistSegmentSyncMarkerDetection({
        segmentId: segment.id,
        result: {
          status: "decode_failed",
          detectedAtMs: null,
          detectedAtSamples: null,
          confidence: 0,
          marker: markerInfo(),
        },
      });
    } catch (persistError) {
      console.error(
        `[sync-marker] segment=${segment.id} failed to persist decode_failed status:`,
        persistError,
      );
    }
  }
}

async function detectAndPersistSyncMarkers(input: {
  sessionId: string;
  trackId: string;
  segments: CompletedSegment[];
  sourceKeys: string[];
  deps: MaterializeTrackDeps;
}) {
  const { sessionId, trackId, segments, sourceKeys, deps } = input;
  // `sourceKeys` is built in lockstep with `segments` (same order/length) by the
  // caller, so a positional zip is the correct segment -> recording mapping.
  const markerSegments = segments
    .map((segment, index) => ({ segment, sourceKey: sourceKeys[index] }))
    .filter(
      (entry): entry is { segment: CompletedSegment; sourceKey: string } =>
        Boolean(entry.segment.syncMarkerVersion && entry.sourceKey),
    );
  if (markerSegments.length === 0) return;

  const detectSyncMarker =
    deps.detectSyncMarker ??
    ((detectInput: DetectSyncMarkerInput) =>
      detectSegmentSyncMarker(detectInput, {
        readObjectBytesRange: deps.readObjectBytesRange ?? getObjectBytesRange,
      }));
  const timeoutMs =
    deps.detectionTimeoutMs ?? SYNC_MARKER_DETECTION_TIMEOUT_MS;

  for (
    let start = 0;
    start < markerSegments.length;
    start += SYNC_MARKER_DETECTION_CONCURRENCY
  ) {
    const batch = markerSegments.slice(
      start,
      start + SYNC_MARKER_DETECTION_CONCURRENCY,
    );
    await Promise.all(
      batch.map(({ segment, sourceKey }) =>
        detectAndPersistOneSegment({
          sessionId,
          trackId,
          segment,
          sourceKey,
          detectSyncMarker,
          timeoutMs,
        }),
      ),
    );
  }
}

async function markTrackFailed(input: {
  trackId: string;
  currentS3Key: string;
  finalKey: string;
  segmentCount: number;
  latestSegmentIndex: number;
}): Promise<MaterializationResult> {
  const { trackId, currentS3Key, finalKey, segmentCount, latestSegmentIndex } =
    input;
  const updated = await db.track.updateMany({
    where: {
      id: trackId,
      status: { not: "complete" },
      segments: {
        none: { segmentIndex: { gt: latestSegmentIndex } },
      },
    },
    data: { status: "failed" },
  });

  if (updated.count === 0) {
    return {
      trackId,
      status: "superseded",
      s3Key: currentS3Key,
      segmentCount,
      durationMs: null,
    };
  }

  return {
    trackId,
    status: "failed",
    s3Key: finalKey,
    segmentCount,
    durationMs: null,
  };
}

async function markTrackFailedIfNoSegments(
  trackId: string,
  currentS3Key: string,
  finalKey: string,
  latestSegmentIndex: number,
): Promise<MaterializationResult> {
  return await markTrackFailed({
    trackId,
    currentS3Key,
    finalKey,
    segmentCount: 0,
    latestSegmentIndex,
  });
}

export async function materializeTrack(
  trackId: string,
  deps: MaterializeTrackDeps = {},
): Promise<MaterializationResult> {
  const track = await db.track.findUnique({
    where: { id: trackId },
    select: {
      id: true,
      sessionId: true,
      s3Key: true,
    },
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
      durationMs: true,
      segmentIndex: true,
      syncMarkerVersion: true,
    },
  });

  const finalKey = trackRecordingKey(track.sessionId, trackId);
  const latestSegment = segments[segments.length - 1];
  const completedSegments = segments.filter(
    (segment) => segment.status === "complete",
  );

  if (
    !latestSegment ||
    (latestSegment.status !== "complete" && !deps.allowIncompleteLatest)
  ) {
    await db.track.updateMany({
      where: { id: trackId, status: { not: "complete" } },
      data: { status: "uploading" },
    });
    return {
      trackId,
      status: "pending",
      s3Key: track.s3Key,
      segmentCount: completedSegments.length,
      durationMs: null,
    };
  }

  let sourceSegments = completedSegments;
  let skippedMissingSegment = false;
  if (deps.skipMissingSegments) {
    const existingSegments: CompletedSegment[] = [];
    for (const segment of completedSegments) {
      if (
        await trackSegmentRecordingExists(track.sessionId, trackId, segment.id)
      ) {
        existingSegments.push(segment);
      } else {
        skippedMissingSegment = true;
        if (segment.syncMarkerVersion) {
          await markSyncMarkerSourceMissing(segment.id);
        }
      }
    }
    sourceSegments = existingSegments;
  }

  if (sourceSegments.length === 0) {
    return await markTrackFailedIfNoSegments(
      trackId,
      track.s3Key,
      finalKey,
      latestSegment.segmentIndex,
    );
  }

  let sourceKeys: string[] = [];
  try {
    if (sourceSegments.length === 1) {
      sourceKeys = [
        trackSegmentRecordingKey(
          track.sessionId,
          trackId,
          sourceSegments[0]!.id,
        ),
      ];
    } else {
      const readObjectBytes = deps.readObjectBytes ?? getObjectBytes;
      const writeObjectBytes = deps.writeObjectBytes ?? putObjectBytes;
      sourceKeys = await segmentRecordingKeys(
        track.sessionId,
        trackId,
        sourceSegments,
        {
          readObjectBytes,
          writeObjectBytes,
        },
      );
    }

    if (sourceKeys.length === 1) {
      const [sourceKey] = sourceKeys;
      if (sourceKey !== finalKey) {
        const readObjectBytes = deps.readObjectBytes ?? getObjectBytes;
        const writeObjectBytes = deps.writeObjectBytes ?? putObjectBytes;
        await writeObjectBytes(finalKey, await readObjectBytes(sourceKey));
      }
    } else {
      const readObjectBytes = deps.readObjectBytes ?? getObjectBytes;
      const writeObjectBytes = deps.writeObjectBytes ?? putObjectBytes;
      const remuxSegments =
        deps.remuxSegments ??
        ((input: RemuxSegmentsInput) =>
          remuxWebmSegments(input, { readObjectBytes, writeObjectBytes }));
      await remuxSegments({ sourceKeys, outputKey: finalKey });
    }
  } catch (error) {
    console.error(`[materialize] track=${trackId} failed:`, error);
    return await markTrackFailed({
      trackId,
      currentS3Key: track.s3Key,
      finalKey,
      segmentCount: sourceSegments.length,
      latestSegmentIndex: latestSegment.segmentIndex,
    });
  }

  const durationMs = totalDurationMs(sourceSegments);
  const partial = deps.partial || skippedMissingSegment;
  const updated = await db.track.updateMany({
    where: {
      id: trackId,
      segments: {
        none: { segmentIndex: { gt: latestSegment.segmentIndex } },
      },
    },
    data: {
      status: "complete",
      s3Key: finalKey,
      durationMs,
      partial,
    },
  });

  if (updated.count === 0) {
    return {
      trackId,
      status: "superseded",
      s3Key: track.s3Key,
      segmentCount: sourceSegments.length,
      durationMs,
    };
  }

  // Sync-marker detection is secondary metadata. The track is already marked
  // complete above, so a detection failure must never reject materialization
  // (which would turn a successful upload into a 500 and skip route cleanup).
  try {
    await detectAndPersistSyncMarkers({
      sessionId: track.sessionId,
      trackId,
      segments: sourceSegments,
      sourceKeys,
      deps,
    });
  } catch (error) {
    console.error(
      `[sync-marker] track=${trackId} detection pass failed:`,
      error,
    );
  }

  return {
    trackId,
    status: "complete",
    s3Key: finalKey,
    segmentCount: sourceSegments.length,
    durationMs,
  };
}
