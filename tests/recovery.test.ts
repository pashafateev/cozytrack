import { describe, it, expect, beforeEach, vi } from "vitest";

type Track = {
  id: string;
  sessionId: string;
  s3Key: string;
  status: string;
  partial: boolean;
};

const trackStore = new Map<string, Track>();
const s3Objects = new Map<string, Uint8Array>();
const s3Timestamps = new Map<string, Date>();
const putCalls: { key: string; bytes: Uint8Array }[] = [];

function putS3(key: string, bytes: Uint8Array, lastModified?: Date) {
  s3Objects.set(key, bytes);
  s3Timestamps.set(key, lastModified ?? new Date(0));
}

vi.mock("@/lib/db", () => ({
  db: {
    track: {
      findUnique: vi.fn(
        async ({
          where: { id },
          select,
        }: {
          where: { id: string };
          select?: Record<string, boolean>;
        }) => {
          const t = trackStore.get(id);
          if (!t) return null;
          if (!select) return structuredClone(t);
          const out: Record<string, unknown> = {};
          for (const k of Object.keys(select)) {
            out[k] = (t as unknown as Record<string, unknown>)[k];
          }
          return out;
        }
      ),
      update: vi.fn(
        async ({
          where: { id },
          data,
        }: {
          where: { id: string };
          data: Partial<Track>;
        }) => {
          const existing = trackStore.get(id);
          if (!existing) throw new Error("not found");
          const updated = { ...existing, ...data };
          trackStore.set(id, updated);
          return structuredClone(updated);
        }
      ),
    },
  },
}));

vi.mock("@/lib/s3", () => ({
  trackRecordingKey: (sessionId: string, trackId: string) =>
    `sessions/${sessionId}/tracks/${trackId}/recording.webm`,
  trackPartKey: (sessionId: string, trackId: string, partNumber: number) =>
    `sessions/${sessionId}/tracks/${trackId}/${partNumber}.webm`,
  trackRecordingExists: vi.fn(async (sessionId: string, trackId: string) =>
    s3Objects.has(
      `sessions/${sessionId}/tracks/${trackId}/recording.webm`
    )
  ),
  listTrackChunkParts: vi.fn(async (sessionId: string, trackId: string) => {
    const prefix = `sessions/${sessionId}/tracks/${trackId}/`;
    const pattern = /^(\d+)\.webm$/;
    const parts: {
      partNumber: number;
      key: string;
      size: number;
      lastModified?: Date;
    }[] = [];
    for (const key of s3Objects.keys()) {
      if (!key.startsWith(prefix)) continue;
      const m = pattern.exec(key.slice(prefix.length));
      if (!m) continue;
      const partNumber = Number(m[1]);
      if (partNumber === 9999) continue;
      parts.push({
        partNumber,
        key,
        size: s3Objects.get(key)?.byteLength ?? 0,
        lastModified: s3Timestamps.get(key),
      });
    }
    parts.sort((a, b) => a.partNumber - b.partNumber);
    return parts;
  }),
  getObjectBytes: vi.fn(async (key: string) => {
    const bytes = s3Objects.get(key);
    if (!bytes) throw new Error(`missing object ${key}`);
    return bytes;
  }),
  putObjectBytes: vi.fn(async (key: string, bytes: Uint8Array) => {
    s3Objects.set(key, bytes);
    s3Timestamps.set(key, new Date());
    putCalls.push({ key, bytes });
  }),
}));

import { recoverTrack } from "@/lib/recovery";

beforeEach(() => {
  trackStore.clear();
  s3Objects.clear();
  s3Timestamps.clear();
  putCalls.length = 0;
  vi.clearAllMocks();
});

function seedTrack(overrides: Partial<Track> = {}): Track {
  const t: Track = {
    id: "t1",
    sessionId: "s1",
    s3Key: "sessions/s1/tracks/t1/recording.webm",
    status: "recording",
    partial: false,
    ...overrides,
  };
  trackStore.set(t.id, t);
  return t;
}

describe("recoverTrack", () => {
  it("throws when the track does not exist", async () => {
    await expect(recoverTrack("missing")).rejects.toThrow();
  });

  it("returns already_complete without touching S3 or DB when status is complete", async () => {
    seedTrack({ status: "complete" });

    const result = await recoverTrack("t1");

    expect(result.outcome).toBe("already_complete");
    expect(result.status).toBe("complete");
    expect(putCalls).toHaveLength(0);
  });

  it("flips to complete when recording.webm already exists in S3", async () => {
    seedTrack();
    s3Objects.set(
      "sessions/s1/tracks/t1/recording.webm",
      new Uint8Array([1, 2, 3])
    );

    const result = await recoverTrack("t1");

    expect(result.outcome).toBe("recovered_from_recording");
    expect(result.partial).toBe(false);
    expect(trackStore.get("t1")?.status).toBe("complete");
    expect(putCalls).toHaveLength(0);
  });

  it("stitches contiguous chunks and marks track complete (not partial)", async () => {
    seedTrack();
    s3Objects.set(
      "sessions/s1/tracks/t1/0.webm",
      new Uint8Array([0xaa, 0xaa])
    );
    s3Objects.set(
      "sessions/s1/tracks/t1/1.webm",
      new Uint8Array([0xbb, 0xbb])
    );
    s3Objects.set(
      "sessions/s1/tracks/t1/2.webm",
      new Uint8Array([0xcc, 0xcc])
    );

    const result = await recoverTrack("t1");

    expect(result.outcome).toBe("recovered_from_chunks");
    expect(result.partial).toBe(false);
    expect(result.chunkCount).toBe(3);
    expect(result.missingPartNumbers).toEqual([]);

    const written = s3Objects.get("sessions/s1/tracks/t1/recording.webm");
    expect(written).toEqual(
      new Uint8Array([0xaa, 0xaa, 0xbb, 0xbb, 0xcc, 0xcc])
    );
    expect(trackStore.get("t1")?.status).toBe("complete");
    expect(trackStore.get("t1")?.partial).toBe(false);
  });

  it("flags partial=true when chunks have gaps in the partNumber sequence", async () => {
    seedTrack();
    // Missing partNumber 2 in the middle.
    s3Objects.set(
      "sessions/s1/tracks/t1/0.webm",
      new Uint8Array([0xaa])
    );
    s3Objects.set(
      "sessions/s1/tracks/t1/1.webm",
      new Uint8Array([0xbb])
    );
    s3Objects.set(
      "sessions/s1/tracks/t1/3.webm",
      new Uint8Array([0xdd])
    );

    const result = await recoverTrack("t1");

    expect(result.outcome).toBe("recovered_partial");
    expect(result.partial).toBe(true);
    expect(result.missingPartNumbers).toEqual([2]);
    expect(trackStore.get("t1")?.partial).toBe(true);
    expect(trackStore.get("t1")?.status).toBe("complete");

    // Chunks remain in S3 — recovery should not delete them.
    expect(s3Objects.has("sessions/s1/tracks/t1/0.webm")).toBe(true);
    expect(s3Objects.has("sessions/s1/tracks/t1/1.webm")).toBe(true);
    expect(s3Objects.has("sessions/s1/tracks/t1/3.webm")).toBe(true);
  });

  it("marks track failed when nothing exists in S3", async () => {
    seedTrack();

    const result = await recoverTrack("t1");

    expect(result.outcome).toBe("failed_no_chunks");
    expect(result.status).toBe("failed");
    expect(trackStore.get("t1")?.status).toBe("failed");
    expect(putCalls).toHaveLength(0);
  });

  it("treats only chunk 0 missing as partial (leading gap)", async () => {
    seedTrack();
    s3Objects.set(
      "sessions/s1/tracks/t1/1.webm",
      new Uint8Array([0xbb])
    );
    s3Objects.set(
      "sessions/s1/tracks/t1/2.webm",
      new Uint8Array([0xcc])
    );

    const result = await recoverTrack("t1");

    expect(result.outcome).toBe("recovered_partial");
    expect(result.partial).toBe(true);
    expect(result.missingPartNumbers).toEqual([0]);
  });

  it("skips chunk-stitch when newest chunk is younger than the gate (active upload race)", async () => {
    seedTrack();
    const now = Date.now();
    // Two chunks, newest one 5 seconds old — still actively uploading.
    putS3(
      "sessions/s1/tracks/t1/0.webm",
      new Uint8Array([0xaa]),
      new Date(now - 60_000)
    );
    putS3(
      "sessions/s1/tracks/t1/1.webm",
      new Uint8Array([0xbb]),
      new Date(now - 5_000)
    );

    const result = await recoverTrack("t1", { chunkStitchMinAgeMs: 30_000 });

    expect(result.outcome).toBe("skipped_active");
    expect(result.chunkCount).toBe(2);
    // Track was not touched — still in recording status, still not partial.
    expect(trackStore.get("t1")?.status).toBe("recording");
    expect(trackStore.get("t1")?.partial).toBe(false);
    expect(putCalls).toHaveLength(0);
  });

  it("proceeds with chunk-stitch when newest chunk is older than the gate", async () => {
    seedTrack();
    const now = Date.now();
    putS3(
      "sessions/s1/tracks/t1/0.webm",
      new Uint8Array([0xaa]),
      new Date(now - 60_000)
    );
    putS3(
      "sessions/s1/tracks/t1/1.webm",
      new Uint8Array([0xbb]),
      new Date(now - 45_000)
    );

    const result = await recoverTrack("t1", { chunkStitchMinAgeMs: 30_000 });

    expect(result.outcome).toBe("recovered_from_chunks");
    expect(trackStore.get("t1")?.status).toBe("complete");
  });

  it("still recovers from recording.webm even when gate is set (cheap check is unconditional)", async () => {
    seedTrack();
    putS3(
      "sessions/s1/tracks/t1/recording.webm",
      new Uint8Array([1, 2, 3]),
      new Date() // very recent
    );

    const result = await recoverTrack("t1", { chunkStitchMinAgeMs: 30_000 });

    expect(result.outcome).toBe("recovered_from_recording");
    expect(trackStore.get("t1")?.status).toBe("complete");
  });

  it("marks failed_too_large when chunk bytes exceed the configured cap", async () => {
    seedTrack();
    putS3(
      "sessions/s1/tracks/t1/0.webm",
      new Uint8Array(500),
      new Date(0)
    );
    putS3(
      "sessions/s1/tracks/t1/1.webm",
      new Uint8Array(600),
      new Date(0)
    );

    const result = await recoverTrack("t1", { maxStitchBytes: 1000 });

    expect(result.outcome).toBe("failed_too_large");
    expect(result.status).toBe("failed");
    expect(trackStore.get("t1")?.status).toBe("failed");
    // Chunks must remain in S3 for manual repair.
    expect(s3Objects.has("sessions/s1/tracks/t1/0.webm")).toBe(true);
    expect(s3Objects.has("sessions/s1/tracks/t1/1.webm")).toBe(true);
    expect(putCalls).toHaveLength(0);
  });
});
