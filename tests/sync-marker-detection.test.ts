import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ffmpegStaticPath from "ffmpeg-static";
import { describe, expect, it } from "vitest";
import {
  SYNC_MARKER_DURATION_MS,
  SYNC_MARKER_END_FREQUENCY_HZ,
  SYNC_MARKER_GAIN,
  SYNC_MARKER_START_FREQUENCY_HZ,
} from "@/lib/sync-marker";
import {
  detectSyncMarkerInPcm,
  detectSyncMarkerInWebmBytes,
  generateSyncMarkerTemplate,
} from "@/lib/sync-marker-detection";

const execFileAsync = promisify(execFile);

function addMarker(
  samples: Float32Array,
  sampleRate: number,
  startAtMs: number,
  gain = 1,
) {
  const marker = generateSyncMarkerTemplate(sampleRate);
  const startSample = Math.round((startAtMs / 1000) * sampleRate);
  for (let i = 0; i < marker.length; i++) {
    samples[startSample + i] += marker[i] * gain;
  }
}

async function encodePcmToWebm(
  samples: Float32Array,
  sampleRate: number,
): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "cozytrack-marker-fixture-"));
  try {
    const pcmPath = join(dir, "input.f32le");
    const webmPath = join(dir, "marker.webm");
    await writeFile(pcmPath, Buffer.from(samples.buffer));
    await execFileAsync(
      process.env.FFMPEG_PATH ?? ffmpegStaticPath ?? "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "f32le",
        "-ar",
        String(sampleRate),
        "-ac",
        "1",
        "-i",
        pcmPath,
        "-c:a",
        "libopus",
        "-b:a",
        "64k",
        webmPath,
      ],
    );
    return await readFile(webmPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("sync marker detection", () => {
  it("detects the generated chirp marker in PCM within a tight tolerance", () => {
    const sampleRate = 48000;
    const markerAtMs = 260;
    const samples = new Float32Array(sampleRate);
    addMarker(samples, sampleRate, markerAtMs);

    const result = detectSyncMarkerInPcm(samples, sampleRate);

    expect(result.status).toBe("detected");
    expect(result.detectedAtMs).toBeGreaterThanOrEqual(markerAtMs - 5);
    expect(result.detectedAtMs).toBeLessThanOrEqual(markerAtMs + 5);
    expect(result.confidence).toBeGreaterThan(0.8);
    expect(result.marker).toMatchObject({
      durationMs: SYNC_MARKER_DURATION_MS,
      startFrequencyHz: SYNC_MARKER_START_FREQUENCY_HZ,
      endFrequencyHz: SYNC_MARKER_END_FREQUENCY_HZ,
      gain: SYNC_MARKER_GAIN,
    });
  });

  it("does not silently mark missing markers as aligned", () => {
    const sampleRate = 48000;
    const samples = new Float32Array(sampleRate);

    const result = detectSyncMarkerInPcm(samples, sampleRate);

    expect(result.status).toBe("missing");
    expect(result.detectedAtMs).toBeNull();
    expect(result.confidence).toBeLessThan(0.35);
  });

  it("detects the marker after real WebM/Opus encoding and ffmpeg decode", async () => {
    const sampleRate = 48000;
    const markerAtMs = 180;
    const samples = new Float32Array(sampleRate);
    addMarker(samples, sampleRate, markerAtMs, 0.9);
    const webm = await encodePcmToWebm(samples, sampleRate);

    const result = await detectSyncMarkerInWebmBytes(webm);

    expect(result.status).toBe("detected");
    expect(result.detectedAtMs).toBeGreaterThanOrEqual(markerAtMs - 20);
    expect(result.detectedAtMs).toBeLessThanOrEqual(markerAtMs + 20);
    expect(result.confidence).toBeGreaterThan(0.55);
  });
});
