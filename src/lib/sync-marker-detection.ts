import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ffmpegStaticPath from "ffmpeg-static";
import {
  SYNC_MARKER_DURATION_MS,
  SYNC_MARKER_END_FREQUENCY_HZ,
  SYNC_MARKER_GAIN,
  SYNC_MARKER_START_FREQUENCY_HZ,
} from "@/lib/sync-marker";

const execFileAsync = promisify(execFile);

const DEFAULT_DECODE_SAMPLE_RATE = 48000;
const DEFAULT_ANALYSIS_SAMPLE_RATE = 8000;
const DEFAULT_MAX_SEARCH_MS = 5000;
// Decoding the bounded window is sub-second in practice; this only exists to
// bound a pathological/malformed input that makes ffmpeg hang instead of fail.
const DECODE_TIMEOUT_MS = 15000;
// Normalized-correlation thresholds tuned empirically against the WebM/Opus
// round-trip fixture (clears ~0.55); >= DETECTED_CONFIDENCE counts as a match,
// the band down to LOW_CONFIDENCE is reported as "low_confidence", and below
// that is treated as "missing".
const DETECTED_CONFIDENCE = 0.45;
const LOW_CONFIDENCE = 0.35;

export type SyncMarkerDetectionStatus =
  | "detected"
  | "low_confidence"
  | "missing"
  | "decode_failed"
  | "source_missing";

export type SyncMarkerDetectionResult = {
  status: SyncMarkerDetectionStatus;
  detectedAtMs: number | null;
  detectedAtSamples: number | null;
  confidence: number;
  marker: {
    durationMs: typeof SYNC_MARKER_DURATION_MS;
    startFrequencyHz: typeof SYNC_MARKER_START_FREQUENCY_HZ;
    endFrequencyHz: typeof SYNC_MARKER_END_FREQUENCY_HZ;
    gain: typeof SYNC_MARKER_GAIN;
  };
};

export type DetectSyncMarkerOptions = {
  analysisSampleRate?: number;
  maxSearchMs?: number;
  detectedConfidence?: number;
  lowConfidence?: number;
};

export function markerInfo(): SyncMarkerDetectionResult["marker"] {
  return {
    durationMs: SYNC_MARKER_DURATION_MS,
    startFrequencyHz: SYNC_MARKER_START_FREQUENCY_HZ,
    endFrequencyHz: SYNC_MARKER_END_FREQUENCY_HZ,
    gain: SYNC_MARKER_GAIN,
  };
}

export function generateSyncMarkerTemplate(sampleRate: number): Float32Array {
  const durationSeconds = SYNC_MARKER_DURATION_MS / 1000;
  const length = Math.round(durationSeconds * sampleRate);
  const template = new Float32Array(length);
  const frequencyDelta =
    SYNC_MARKER_END_FREQUENCY_HZ - SYNC_MARKER_START_FREQUENCY_HZ;
  const fadeInSeconds = 0.01;
  const fadeOutSeconds = 0.02;

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const phase =
      2 *
      Math.PI *
      (SYNC_MARKER_START_FREQUENCY_HZ * t +
        (0.5 * frequencyDelta * t * t) / durationSeconds);
    let envelope = SYNC_MARKER_GAIN;
    if (t < fadeInSeconds) {
      envelope *= t / fadeInSeconds;
    } else if (durationSeconds - t < fadeOutSeconds) {
      envelope *= Math.max(0, (durationSeconds - t) / fadeOutSeconds);
    }
    template[i] = Math.sin(phase) * envelope;
  }

  return template;
}

function resampleLinear(
  samples: Float32Array,
  sampleRate: number,
  targetSampleRate: number,
): Float32Array {
  if (sampleRate === targetSampleRate) return samples;

  const length = Math.max(0, Math.floor((samples.length * targetSampleRate) / sampleRate));
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const sourcePosition = (i * sampleRate) / targetSampleRate;
    const left = Math.floor(sourcePosition);
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = sourcePosition - left;
    output[i] = samples[left] * (1 - fraction) + samples[right] * fraction;
  }
  return output;
}

function energy(samples: Float32Array): number {
  let total = 0;
  for (let i = 0; i < samples.length; i++) {
    total += samples[i] * samples[i];
  }
  return total;
}

function normalizedCorrelationAt(
  samples: Float32Array,
  template: Float32Array,
  templateEnergy: number,
  offset: number,
): number {
  let dot = 0;
  let sampleEnergy = 0;
  for (let i = 0; i < template.length; i++) {
    const sample = samples[offset + i];
    dot += sample * template[i];
    sampleEnergy += sample * sample;
  }
  if (sampleEnergy === 0 || templateEnergy === 0) return 0;
  return dot / Math.sqrt(sampleEnergy * templateEnergy);
}

function emptyResult(status: SyncMarkerDetectionStatus, confidence = 0): SyncMarkerDetectionResult {
  return {
    status,
    detectedAtMs: null,
    detectedAtSamples: null,
    confidence,
    marker: markerInfo(),
  };
}

export function detectSyncMarkerInPcm(
  samples: Float32Array,
  sampleRate: number,
  options: DetectSyncMarkerOptions = {},
): SyncMarkerDetectionResult {
  const analysisSampleRate =
    options.analysisSampleRate ?? DEFAULT_ANALYSIS_SAMPLE_RATE;
  const maxSearchMs = options.maxSearchMs ?? DEFAULT_MAX_SEARCH_MS;
  const detectedConfidence =
    options.detectedConfidence ?? DETECTED_CONFIDENCE;
  const lowConfidence = options.lowConfidence ?? LOW_CONFIDENCE;

  // Detection only searches the first `maxSearchMs`, so cap the input to that
  // window (plus one marker length) before resampling to avoid processing the
  // entire recording for long tracks.
  const searchWindowMs = maxSearchMs + SYNC_MARKER_DURATION_MS;
  const neededSourceSamples =
    Math.ceil((searchWindowMs / 1000) * sampleRate) + 1;
  const windowedSamples =
    samples.length > neededSourceSamples
      ? samples.subarray(0, neededSourceSamples)
      : samples;

  const analysisSamples = resampleLinear(
    windowedSamples,
    sampleRate,
    analysisSampleRate,
  );
  const template = generateSyncMarkerTemplate(analysisSampleRate);
  if (analysisSamples.length < template.length) return emptyResult("missing");

  const latestOffset = Math.min(
    analysisSamples.length - template.length,
    Math.max(0, Math.floor((maxSearchMs / 1000) * analysisSampleRate)),
  );
  const templateEnergy = energy(template);
  const coarseStep = Math.max(1, Math.round(0.004 * analysisSampleRate));
  let bestOffset = 0;
  let bestConfidence = -1;

  for (let offset = 0; offset <= latestOffset; offset += coarseStep) {
    const confidence = normalizedCorrelationAt(
      analysisSamples,
      template,
      templateEnergy,
      offset,
    );
    if (confidence > bestConfidence) {
      bestConfidence = confidence;
      bestOffset = offset;
    }
  }

  const refineStart = Math.max(0, bestOffset - coarseStep);
  const refineEnd = Math.min(latestOffset, bestOffset + coarseStep);
  for (let offset = refineStart; offset <= refineEnd; offset++) {
    const confidence = normalizedCorrelationAt(
      analysisSamples,
      template,
      templateEnergy,
      offset,
    );
    if (confidence > bestConfidence) {
      bestConfidence = confidence;
      bestOffset = offset;
    }
  }

  const confidence = Math.max(0, bestConfidence);
  if (confidence < lowConfidence) return emptyResult("missing", confidence);
  if (confidence < detectedConfidence) {
    return emptyResult("low_confidence", confidence);
  }

  const detectedAtMs = (bestOffset / analysisSampleRate) * 1000;
  return {
    status: "detected",
    detectedAtMs,
    detectedAtSamples: Math.round((bestOffset / analysisSampleRate) * sampleRate),
    confidence,
    marker: markerInfo(),
  };
}

export async function decodeWebmToPcm(
  bytes: Uint8Array,
  sampleRate = DEFAULT_DECODE_SAMPLE_RATE,
  maxDurationMs?: number,
): Promise<Float32Array> {
  const dir = await mkdtemp(join(tmpdir(), "cozytrack-marker-decode-"));
  try {
    const inputPath = join(dir, "input.webm");
    const outputPath = join(dir, "output.f32le");
    await writeFile(inputPath, bytes);
    const durationArgs =
      maxDurationMs && maxDurationMs > 0
        ? ["-t", (maxDurationMs / 1000).toFixed(3)]
        : [];
    await execFileAsync(
      process.env.FFMPEG_PATH ?? ffmpegStaticPath ?? "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        inputPath,
        ...durationArgs,
        "-ac",
        "1",
        "-ar",
        String(sampleRate),
        "-f",
        "f32le",
        outputPath,
      ],
      // Hard-kill a hung/malformed decode so it can't tie up the caller. The
      // rejection is surfaced to detection and recorded as a failed decode.
      { timeout: DECODE_TIMEOUT_MS, killSignal: "SIGKILL" },
    );
    const output = await readFile(outputPath);
    const arrayBuffer = output.buffer.slice(
      output.byteOffset,
      output.byteOffset + output.byteLength,
    );
    return new Float32Array(arrayBuffer);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function detectSyncMarkerInWebmBytes(
  bytes: Uint8Array,
  options: DetectSyncMarkerOptions = {},
): Promise<SyncMarkerDetectionResult> {
  const maxSearchMs = options.maxSearchMs ?? DEFAULT_MAX_SEARCH_MS;
  // Only decode the window detection actually searches (plus one marker length
  // of slack), so long recordings don't fill /tmp or blow up memory.
  const maxDecodeMs = maxSearchMs + SYNC_MARKER_DURATION_MS;
  const samples = await decodeWebmToPcm(
    bytes,
    DEFAULT_DECODE_SAMPLE_RATE,
    maxDecodeMs,
  );
  return detectSyncMarkerInPcm(samples, DEFAULT_DECODE_SAMPLE_RATE, options);
}
