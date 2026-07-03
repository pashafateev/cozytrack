import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ffmpegStaticPath from "ffmpeg-static";
import { db } from "@/lib/db";
import {
  getObjectBytes,
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
  writeObjectBytes?: (key: string, bytes: Uint8Array) => Promise<void>;
  remuxSegments?: (input: RemuxSegmentsInput) => Promise<void>;
  partial?: boolean;
  allowIncompleteLatest?: boolean;
  skipMissingSegments?: boolean;
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

  return {
    trackId,
    status: "complete",
    s3Key: finalKey,
    segmentCount: sourceSegments.length,
    durationMs,
  };
}
