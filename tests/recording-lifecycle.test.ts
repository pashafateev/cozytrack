import { describe, expect, it, vi } from "vitest";
import {
  RecordingLifecycleController,
  type RecorderLike,
  type RecordingSlotSpec,
} from "@/lib/recording-lifecycle";
import type { RecordingBackupManifest } from "@/lib/recording-backup";

// Unit tests for the unified slot recording lifecycle (issue #135 refactor).
// The controller is a plain object — no React — so these tests drive it
// directly with fake deps and assert the invariants both studio modes rely on:
//
//  1. Per-channel independence at every stage (stop/finalize/backup ops).
//  2. All in-flight uploads drain before any completeUpload.
//  3. markBackupAvailable(durationMs) lands before the final upload.
//  4. Every backup state change surfaces through the recovery callbacks.
//  5. Partial-start rollback finalizes already-started slots.
//  6. Resources are torn down on every error/cancel path.
//  7. Crash-safe backup ordering: startBackup → saveChunk →
//     markChunkUploaded/Failed → markBackupAvailable → clearBackup/markBackupFailed.

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks and zero-delay timers run a few rounds. */
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

class FakeRecorder implements RecorderLike {
  handler: ((chunk: Blob, index: number) => void) | null = null;
  started = false;
  stopped = false;
  startTimeSlice: number | undefined;
  startGate: Promise<void> | null = null;
  startError: Error | null = null;
  stopError: Error | null = null;
  stopBlob = new Blob(["final-recording"], { type: "audio/webm" });

  onChunk(callback: (chunk: Blob, index: number) => void): void {
    this.handler = callback;
  }

  async start(timeSliceMs?: number): Promise<void> {
    this.startTimeSlice = timeSliceMs;
    if (this.startGate) await this.startGate;
    if (this.startError) throw this.startError;
    this.started = true;
  }

  async stop(): Promise<Blob> {
    this.stopped = true;
    if (this.stopError) throw this.stopError;
    return this.stopBlob;
  }

  emit(chunk: Blob, index: number): void {
    this.handler?.(chunk, index);
  }
}

function manifest(
  overrides: Partial<RecordingBackupManifest> = {},
): RecordingBackupManifest {
  return {
    id: "session-1:segment",
    sessionId: "session-1",
    trackId: "track",
    participantName: "P",
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
    state: "recording",
    persistentStorage: true,
    chunks: [],
    ...overrides,
  };
}

function makeHarness(
  options: { failRecorderStartAt?: number; gateRecorderStartAt?: number } = {},
) {
  const log: string[] = [];
  const recorders: FakeRecorder[] = [];
  const recorderStartGate = deferred<void>();
  const events = {
    recovery: [] as (RecordingBackupManifest | null)[],
    errors: [] as (string | null)[],
    unavailable: [] as string[],
    timing: [] as Record<string, unknown>[],
    stopSettled: [] as { allCompleted: boolean }[],
  };
  let clock = 1_000;
  let trackSeq = 0;

  // Mini tracker with the real drain semantics of useUploadProgress:
  // trackUpload never rejects unless rethrow, waitForUploads loops until the
  // in-flight set is empty.
  const inflight = new Set<Promise<void>>();
  const tracker = {
    reset: vi.fn(() => {
      log.push("tracker.reset");
    }),
    onChunkRecorded: vi.fn(),
    freezeRecorded: vi.fn(() => {
      log.push("freezeRecorded");
    }),
    trackUpload: vi.fn(
      (
        _byteLength: number,
        uploadPromise: Promise<void>,
        options?: { rethrow?: boolean },
      ): Promise<void> => {
        const settledResult = uploadPromise.then(
          () => ({ ok: true as const }),
          (err: unknown) => ({ ok: false as const, err }),
        );
        const tracked: Promise<void> = settledResult
          .then(() => undefined)
          .finally(() => {
            inflight.delete(tracked);
          });
        inflight.add(tracked);
        if (options?.rethrow) {
          return tracked.then(async () => {
            const result = await settledResult;
            if (!result.ok) throw result.err;
          });
        }
        return tracked;
      },
    ),
    waitForUploads: vi.fn(async () => {
      while (inflight.size > 0) {
        await Promise.allSettled(Array.from(inflight));
      }
    }),
  };

  const uploadApi = {
    getPresignedUploadTarget: vi.fn(
      async (
        _sessionId: string,
        _trackId: string,
        _partNumber: number,
        _participantName?: string,
        trackInit?: { localTrackSlotId?: string },
      ) => {
        const key = trackInit?.localTrackSlotId ?? "primary";
        log.push(`presignTarget:${key}`);
        return {
          url: `https://s3.test/${key}/0.webm`,
          recordingToken: `token-${key}`,
          trackId: `track-${key}`,
          segmentId: `segment-${key}`,
        };
      },
    ),
    getPresignedUploadUrl: vi.fn(
      async (_sessionId: string, trackId: string, partNumber: number) => {
        log.push(`presignUrl:${trackId}:${partNumber}`);
        return `https://s3.test/${trackId}/${partNumber}.webm`;
      },
    ),
    uploadChunk: vi.fn(async (url: string) => {
      log.push(`uploadChunk:${url}`);
    }),
    completeUpload: vi.fn(
      async (
        _sessionId: string,
        trackId: string,
        _durationMs?: number,
        _recordingToken?: string,
        _segmentId?: string,
      ) => {
        log.push(`complete:${trackId}`);
      },
    ),
  };

  const backupStore = {
    startBackup: vi.fn(
      async (input: { sessionId: string; segmentId?: string; trackId: string }) => {
        log.push(`startBackup:${input.segmentId}`);
        return manifest({
          id: `${input.sessionId}:${input.segmentId}`,
          trackId: input.trackId,
          segmentId: input.segmentId,
          state: "recording",
        });
      },
    ),
    saveChunk: vi.fn(
      async (input: { segmentId?: string; chunkIndex: number }) => {
        log.push(`saveChunk:${input.segmentId}:${input.chunkIndex}`);
        return manifest({ segmentId: input.segmentId, state: "recording" });
      },
    ),
    markChunkUploaded: vi.fn(
      async (
        _sessionId: string,
        _trackId: string,
        chunkIndex: number,
        segmentId?: string,
      ) => {
        log.push(`markChunkUploaded:${segmentId}:${chunkIndex}`);
        return manifest({ segmentId });
      },
    ),
    markChunkFailed: vi.fn(
      async (
        _sessionId: string,
        _trackId: string,
        chunkIndex: number,
        _error: unknown,
        segmentId?: string,
      ) => {
        log.push(`markChunkFailed:${segmentId}:${chunkIndex}`);
        return manifest({ segmentId, state: "failed" });
      },
    ),
    markBackupAvailable: vi.fn(async (id: string, durationMs?: number) => {
      log.push(`markBackupAvailable:${id}:${durationMs}`);
      return manifest({ id, state: "available", durationMs });
    }),
    markBackupFailed: vi.fn(async (id: string) => {
      log.push(`markBackupFailed:${id}`);
      return manifest({ id, state: "failed" });
    }),
    clearBackup: vi.fn(async (id: string, reason: string) => {
      log.push(`clearBackup:${id}:${reason}`);
    }),
  };

  const controller = new RecordingLifecycleController({
    sessionId: "session-1",
    uploadApi,
    backupStore,
    tracker,
    createRecorder: () => {
      const recorder = new FakeRecorder();
      if (recorders.length === options.failRecorderStartAt) {
        recorder.startError = new Error("recorder start failed");
      }
      if (recorders.length === options.gateRecorderStartAt) {
        recorder.startGate = recorderStartGate.promise;
      }
      recorders.push(recorder);
      return recorder;
    },
    generateTrackId: () => `requested-${(trackSeq += 1)}`,
    now: () => clock,
    callbacks: {
      onRecoveryBackup: (m) => events.recovery.push(m),
      onBackupError: (message) => events.errors.push(message),
      onBackupUnavailable: (spec) => events.unavailable.push(spec.participantName),
      onTiming: (event) => events.timing.push(event),
      onStopSettled: (outcome) => events.stopSettled.push(outcome),
    },
  });

  return {
    controller,
    recorders,
    uploadApi,
    backupStore,
    tracker,
    log,
    events,
    advance: (ms: number) => {
      clock += ms;
    },
    releaseRecorderStart: () => recorderStartGate.resolve(),
  };
}

const START_OPTS = {
  sessionStartedAt: "2026-07-09T12:00:00.000Z",
  takeId: "take-1",
};

function primarySpec(): RecordingSlotSpec {
  return {
    participantName: "Pasha",
    stream: {} as MediaStream,
    deviceInfo: {
      deviceLabel: "Shure MV7",
      deviceId: "usb-mic",
      isBuiltInMic: false,
    },
  };
}

function slotSpec(n: 1 | 2): RecordingSlotSpec {
  return {
    localTrackSlotId: `host-local-ch-${n}`,
    participantName: `Local Ch ${n}`,
    stream: {} as MediaStream,
    deviceInfo: {
      deviceLabel: `Local Ch ${n} · Interface`,
      deviceId: "usb-interface",
      isBuiltInMic: false,
    },
  };
}

describe("RecordingLifecycleController start", () => {
  it("starts a single primary slot: presign, backup, recorder — in order", async () => {
    const h = makeHarness();

    const result = await h.controller.start([primarySpec()], START_OPTS);

    expect(result).toEqual({ ok: true });
    expect(h.controller.active).toBe(true);
    expect(h.uploadApi.getPresignedUploadTarget).toHaveBeenCalledWith(
      "session-1",
      "requested-1",
      0,
      "Pasha",
      {
        deviceInfo: {
          deviceLabel: "Shure MV7",
          deviceId: "usb-mic",
          isBuiltInMic: false,
        },
        sessionStartedAt: START_OPTS.sessionStartedAt,
        takeId: "take-1",
        localTrackSlotId: undefined,
      },
    );
    // Backup is keyed to the server-corrected segment id and carries the token.
    expect(h.backupStore.startBackup).toHaveBeenCalledWith({
      sessionId: "session-1",
      trackId: "track-primary",
      segmentId: "segment-primary",
      participantName: "Pasha",
      recordingToken: "token-primary",
    });
    expect(h.recorders).toHaveLength(1);
    expect(h.recorders[0].started).toBe(true);
    expect(h.recorders[0].startTimeSlice).toBe(5000);
    expect(h.log.indexOf("presignTarget:primary")).toBeLessThan(
      h.log.indexOf("startBackup:segment-primary"),
    );
    // The tracker resets exactly once per take.
    expect(h.tracker.reset).toHaveBeenCalledTimes(1);
  });

  it("starts two channel slots with their distinct slot ids", async () => {
    const h = makeHarness();

    const result = await h.controller.start([slotSpec(1), slotSpec(2)], START_OPTS);

    expect(result).toEqual({ ok: true });
    const slotIds = h.uploadApi.getPresignedUploadTarget.mock.calls.map(
      (call) => (call[4] as { localTrackSlotId?: string }).localTrackSlotId,
    );
    expect(slotIds).toEqual(["host-local-ch-1", "host-local-ch-2"]);
    expect(h.recorders).toHaveLength(2);
    expect(h.recorders.every((recorder) => recorder.started)).toBe(true);
    expect(h.tracker.reset).toHaveBeenCalledTimes(1);
  });

  it("falls back to the requested track id when presign returns none", async () => {
    const h = makeHarness();
    h.uploadApi.getPresignedUploadTarget.mockResolvedValueOnce({
      url: "https://s3.test/plain/0.webm",
    } as never);

    await h.controller.start([primarySpec()], START_OPTS);

    expect(h.backupStore.startBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        trackId: "requested-1",
        segmentId: "requested-1",
        recordingToken: undefined,
      }),
    );
  });

  it("refuses to start while already active", async () => {
    const h = makeHarness();
    await h.controller.start([primarySpec()], START_OPTS);

    const second = await h.controller.start([primarySpec()], START_OPTS);

    expect(second).toEqual({ ok: false, stage: "already-active" });
    expect(h.recorders).toHaveLength(1);
  });

  it("refuses to start with no slots", async () => {
    const h = makeHarness();

    const result = await h.controller.start([], START_OPTS);

    expect(result).toEqual({ ok: false, stage: "no-slots" });
    expect(h.controller.active).toBe(false);
  });

  it("continues without a backup when startBackup fails", async () => {
    const h = makeHarness();
    h.backupStore.startBackup.mockRejectedValueOnce(new Error("no storage"));

    const result = await h.controller.start([primarySpec()], START_OPTS);

    expect(result).toEqual({ ok: true });
    expect(h.events.unavailable).toEqual(["Pasha"]);
    expect(h.events.recovery.at(-1)).toBeNull();
    expect(h.events.errors.at(-1)).toBe("no storage");

    // Chunk saves are skipped (no manifest to attach them to), but the remote
    // upload still runs.
    h.recorders[0].emit(new Blob(["chunk-a"], { type: "audio/webm" }), 0);
    await settle();
    expect(h.backupStore.saveChunk).not.toHaveBeenCalled();
    expect(h.uploadApi.uploadChunk).toHaveBeenCalledTimes(1);

    // And stop-time backup ops are skipped too.
    const stop = await h.controller.stop();
    expect(stop.anyCompleted).toBe(true);
    expect(h.backupStore.markBackupAvailable).not.toHaveBeenCalled();
    expect(h.backupStore.clearBackup).not.toHaveBeenCalled();
  });

  it("rolls back an already-started slot when a later slot's presign fails", async () => {
    const h = makeHarness();
    h.uploadApi.getPresignedUploadTarget.mockImplementation(
      (async (
        _sessionId: string,
        _trackId: string,
        _part: number,
        _name?: string,
        trackInit?: { localTrackSlotId?: string },
      ) => {
        if (trackInit?.localTrackSlotId === "host-local-ch-2") {
          throw new Error("ch2 presign failed");
        }
        h.log.push("presignTarget:host-local-ch-1");
        return {
          url: "https://s3.test/ch1/0.webm",
          recordingToken: "token-ch1",
          trackId: "track-host-local-ch-1",
          segmentId: "segment-host-local-ch-1",
        };
      }) as never,
    );

    const result = await h.controller.start([slotSpec(1), slotSpec(2)], START_OPTS);

    expect(result).toEqual({ ok: false, stage: "presign" });
    expect(h.controller.active).toBe(false);
    // The started channel is stopped and finalized so no server track is left
    // recording — including its duration-stamped backup handoff.
    expect(h.recorders[0].stopped).toBe(true);
    expect(h.uploadApi.completeUpload).toHaveBeenCalledTimes(1);
    expect(h.uploadApi.completeUpload.mock.calls[0][1]).toBe(
      "track-host-local-ch-1",
    );
    expect(h.backupStore.markBackupAvailable).toHaveBeenCalledWith(
      "session-1:segment-host-local-ch-1",
      expect.any(Number),
    );
    expect(h.backupStore.clearBackup).toHaveBeenCalledWith(
      "session-1:segment-host-local-ch-1",
      "verified-upload",
    );
  });

  it("concludes the failed slot's server track when its recorder refuses to start", async () => {
    // The presign already created a server track before recorder.start()
    // rejected. With no recording data anywhere, the slot must still be
    // completed server-side so materialization converges the track to failed
    // instead of leaving it stuck in `recording`, which would 409-block
    // session finalize forever (Codex P1 #2 on PR #165).
    const h = makeHarness({ failRecorderStartAt: 0 });

    const result = await h.controller.start([primarySpec()], START_OPTS);

    expect(result).toEqual({ ok: false, stage: "recorder-start" });
    expect(h.controller.active).toBe(false);
    expect(h.uploadApi.completeUpload).toHaveBeenCalledTimes(1);
    expect(h.uploadApi.completeUpload).toHaveBeenCalledWith(
      "session-1",
      "track-primary",
      undefined,
      "token-primary",
      "segment-primary",
    );
  });

  it("rolls back when a later slot's recorder fails to start", async () => {
    // The second recorder created refuses to start.
    const h = makeHarness({ failRecorderStartAt: 1 });

    const result = await h.controller.start([slotSpec(1), slotSpec(2)], START_OPTS);

    expect(result).toEqual({ ok: false, stage: "recorder-start" });
    expect(h.controller.active).toBe(false);
    expect(h.recorders[0].stopped).toBe(true);
    // Both server tracks converge: the failing slot is concluded with no
    // recording (duration undefined), the started sibling finalizes normally.
    const completions = h.uploadApi.completeUpload.mock.calls.map((call) => ({
      trackId: call[1],
      durationMs: call[2],
    }));
    expect(completions).toHaveLength(2);
    expect(completions).toContainEqual({
      trackId: "track-host-local-ch-2",
      durationMs: undefined,
    });
    expect(
      completions.find((entry) => entry.trackId === "track-host-local-ch-1")
        ?.durationMs,
    ).toEqual(expect.any(Number));
  });

  it("survives a rollback where the started slot's recorder refuses to stop", async () => {
    const h = makeHarness();
    h.uploadApi.getPresignedUploadTarget
      .mockImplementationOnce((async () => {
        h.log.push("presignTarget:host-local-ch-1");
        return {
          url: "https://s3.test/ch1/0.webm",
          recordingToken: "token-ch1",
          trackId: "track-host-local-ch-1",
          segmentId: "segment-host-local-ch-1",
        };
      }) as never)
      .mockImplementationOnce((async () => {
        // Give the first recorder a failing stop before slot 2 fails.
        h.recorders[0].stopError = new Error("stop failed");
        throw new Error("ch2 presign failed");
      }) as never);

    const result = await h.controller.start([slotSpec(1), slotSpec(2)], START_OPTS);

    expect(result).toEqual({ ok: false, stage: "presign" });
    expect(h.controller.active).toBe(false);
    // Nothing to finalize (no blob), but the rollback must not throw — and
    // the slot's server track stays open on purpose: chunks may already be
    // uploaded, and /complete would delete them. The local backup is kept and
    // marked failed so the recovery panel can re-drive the track.
    expect(h.uploadApi.completeUpload).not.toHaveBeenCalled();
    expect(h.backupStore.markBackupFailed).toHaveBeenCalledWith(
      "session-1:segment-host-local-ch-1",
      expect.anything(),
    );
    expect(h.events.recovery.at(-1)?.state).toBe("failed");
  });
});

describe("RecordingLifecycleController chunk pipeline", () => {
  it("runs the crash-safe order: saveChunk → presign → upload → markChunkUploaded", async () => {
    const h = makeHarness();
    await h.controller.start([primarySpec()], START_OPTS);

    h.recorders[0].emit(new Blob(["chunk-a"], { type: "audio/webm" }), 0);
    await settle();

    const saveIndex = h.log.indexOf("saveChunk:segment-primary:0");
    const presignIndex = h.log.indexOf("presignUrl:track-primary:0");
    const uploadIndex = h.log.findIndex((entry) =>
      entry.startsWith("uploadChunk:https://s3.test/track-primary/0"),
    );
    const markIndex = h.log.indexOf("markChunkUploaded:segment-primary:0");
    expect(saveIndex).toBeGreaterThanOrEqual(0);
    expect(saveIndex).toBeLessThan(presignIndex);
    expect(presignIndex).toBeLessThan(uploadIndex);
    expect(uploadIndex).toBeLessThan(markIndex);

    // The tracker saw the bytes and the upload.
    expect(h.tracker.onChunkRecorded).toHaveBeenCalledWith(7);
    expect(h.tracker.trackUpload).toHaveBeenCalledTimes(1);
    // Chunk presign carries the slot's segment and token.
    expect(h.uploadApi.getPresignedUploadUrl).toHaveBeenCalledWith(
      "session-1",
      "track-primary",
      0,
      undefined,
      { segmentId: "segment-primary" },
      "token-primary",
    );
    // Backup state changes surfaced along the way.
    expect(h.events.recovery.length).toBeGreaterThanOrEqual(2);
  });

  it("marks the chunk failed in the backup when its upload fails", async () => {
    const h = makeHarness();
    await h.controller.start([primarySpec()], START_OPTS);
    h.uploadApi.uploadChunk.mockRejectedValueOnce(new Error("PUT failed"));

    h.recorders[0].emit(new Blob(["chunk-a"], { type: "audio/webm" }), 0);
    await settle();

    expect(h.backupStore.markChunkFailed).toHaveBeenCalledTimes(1);
    expect(h.backupStore.markChunkUploaded).not.toHaveBeenCalled();
    // The failed-chunk manifest surfaced to the recovery callback.
    expect(h.events.recovery.at(-1)?.state).toBe("failed");
  });

  it("still uploads the chunk remotely when the local backup write fails", async () => {
    const h = makeHarness();
    await h.controller.start([primarySpec()], START_OPTS);
    h.backupStore.saveChunk.mockRejectedValueOnce(new Error("disk full"));

    h.recorders[0].emit(new Blob(["chunk-a"], { type: "audio/webm" }), 0);
    await settle();

    expect(h.uploadApi.uploadChunk).toHaveBeenCalledTimes(1);
    expect(h.events.errors.at(-1)).toBe("disk full");
    // No manifest entry to mark uploaded.
    expect(h.backupStore.markChunkUploaded).not.toHaveBeenCalled();
  });
});

describe("RecordingLifecycleController stop", () => {
  it("finalizes a single slot: available → final upload → drain → complete → clear", async () => {
    const h = makeHarness();
    await h.controller.start([primarySpec()], START_OPTS);
    h.advance(60_000);

    const result = await h.controller.stop();

    expect(result).toEqual({ stopped: true, anyCompleted: true });
    expect(h.controller.active).toBe(false);

    // markBackupAvailable carries the measured duration and lands BEFORE the
    // final upload, so a mid-upload crash still recovers with a duration.
    expect(h.backupStore.markBackupAvailable).toHaveBeenCalledWith(
      "session-1:segment-primary",
      60_000,
    );
    const availableIndex = h.log.indexOf(
      "markBackupAvailable:session-1:segment-primary:60000",
    );
    const finalPresignIndex = h.log.indexOf("presignUrl:track-primary:9999");
    const completeIndex = h.log.indexOf("complete:track-primary");
    const clearIndex = h.log.indexOf(
      "clearBackup:session-1:segment-primary:verified-upload",
    );
    expect(availableIndex).toBeGreaterThanOrEqual(0);
    expect(availableIndex).toBeLessThan(finalPresignIndex);
    expect(finalPresignIndex).toBeLessThan(completeIndex);
    expect(completeIndex).toBeLessThan(clearIndex);

    expect(h.uploadApi.completeUpload).toHaveBeenCalledWith(
      "session-1",
      "track-primary",
      60_000,
      "token-primary",
      "segment-primary",
    );
    // A fully verified upload leaves no surfaced backup or error behind.
    expect(h.events.recovery.at(-1)).toBeNull();
    expect(h.events.errors.at(-1)).toBeNull();
  });

  it("is a no-op when nothing is recording", async () => {
    const h = makeHarness();

    const result = await h.controller.stop();

    expect(result).toEqual({ stopped: false, anyCompleted: false });
  });

  it("no-ops a second stop while the first is still finalizing", async () => {
    const h = makeHarness();
    await h.controller.start([primarySpec()], START_OPTS);

    const first = h.controller.stop();
    const second = await h.controller.stop();
    expect(second).toEqual({ stopped: false, anyCompleted: false });
    const firstResult = await first;
    expect(firstResult.stopped).toBe(true);
    expect(h.uploadApi.completeUpload).toHaveBeenCalledTimes(1);
  });

  it("drains in-flight chunk uploads before completing any slot", async () => {
    const h = makeHarness();
    await h.controller.start([slotSpec(1), slotSpec(2)], START_OPTS);

    const gate = deferred<void>();
    const heldChunk = new Blob(["held-chunk"], { type: "audio/webm" });
    h.uploadApi.uploadChunk.mockImplementation((async (
      _url: string,
      blob: Blob,
    ) => {
      if (blob === heldChunk) await gate.promise;
    }) as never);

    h.recorders[0].emit(heldChunk, 0);
    await settle();

    const stopPromise = h.controller.stop();
    await settle(10);

    // /complete deletes chunk objects server-side; completing while a chunk
    // PUT is still in flight would strand it.
    expect(h.uploadApi.completeUpload).not.toHaveBeenCalled();

    gate.resolve();
    const result = await stopPromise;
    expect(result.anyCompleted).toBe(true);
    const completed = h.uploadApi.completeUpload.mock.calls.map(
      (call) => call[1],
    );
    expect(completed).toContain("track-host-local-ch-1");
    expect(completed).toContain("track-host-local-ch-2");
  });

  it("still finalizes the sibling when one recorder's stop() rejects", async () => {
    const h = makeHarness();
    await h.controller.start([slotSpec(1), slotSpec(2)], START_OPTS);
    h.recorders[0].stopError = new Error("ch1 stop failed");

    const result = await h.controller.stop();

    // Ch 2 completed even though Ch 1's recorder died mid-stop.
    expect(result).toEqual({ stopped: true, anyCompleted: true });
    const completed = h.uploadApi.completeUpload.mock.calls.map(
      (call) => call[1],
    );
    expect(completed).toEqual(["track-host-local-ch-2"]);
    // Ch 1's backup is kept and marked failed for recovery.
    expect(h.backupStore.markBackupFailed).toHaveBeenCalledWith(
      "session-1:segment-host-local-ch-1",
      expect.anything(),
    );
    expect(h.backupStore.clearBackup).toHaveBeenCalledTimes(1);
    expect(h.backupStore.clearBackup).toHaveBeenCalledWith(
      "session-1:segment-host-local-ch-2",
      "verified-upload",
    );
  });

  it("still completes the healthy channel when the other's final upload fails", async () => {
    const h = makeHarness();
    await h.controller.start([slotSpec(1), slotSpec(2)], START_OPTS);
    h.uploadApi.getPresignedUploadUrl.mockImplementation((async (
      _sessionId: string,
      trackId: string,
      partNumber: number,
    ) => {
      if (trackId === "track-host-local-ch-1" && partNumber === 9999) {
        throw new Error("ch1 final upload failed");
      }
      h.log.push(`presignUrl:${trackId}:${partNumber}`);
      return `https://s3.test/${trackId}/${partNumber}.webm`;
    }) as never);

    const result = await h.controller.stop();

    expect(result.anyCompleted).toBe(true);
    const completed = h.uploadApi.completeUpload.mock.calls.map(
      (call) => call[1],
    );
    expect(completed).toContain("track-host-local-ch-2");
    expect(completed).not.toContain("track-host-local-ch-1");
    expect(h.backupStore.markBackupFailed).toHaveBeenCalledWith(
      "session-1:segment-host-local-ch-1",
      expect.anything(),
    );
  });

  it("keeps a failed slot's backup surfaced even when the sibling clears afterwards", async () => {
    const h = makeHarness();
    await h.controller.start([slotSpec(1), slotSpec(2)], START_OPTS);

    // Ch 1's final upload fails; Ch 2's verified-upload clear is held until
    // Ch 1's failed manifest has already surfaced. The failed manifest must
    // win over the sibling's later clear-to-null.
    const ch1Failed = deferred<void>();
    h.uploadApi.getPresignedUploadUrl.mockImplementation((async (
      _sessionId: string,
      trackId: string,
      partNumber: number,
    ) => {
      if (trackId === "track-host-local-ch-1" && partNumber === 9999) {
        throw new Error("ch1 final upload failed");
      }
      return `https://s3.test/${trackId}/${partNumber}.webm`;
    }) as never);
    h.backupStore.markBackupFailed.mockImplementation(async (id: string) => {
      ch1Failed.resolve();
      return manifest({ id, state: "failed" });
    });
    h.backupStore.clearBackup.mockImplementation(async (id: string) => {
      await ch1Failed.promise;
      h.log.push(`clearBackup:${id}`);
    });

    await h.controller.stop();

    const lastRecovery = h.events.recovery.at(-1);
    expect(lastRecovery?.state).toBe("failed");
    expect(lastRecovery?.id).toBe("session-1:segment-host-local-ch-1");
  });

  it("keeps the backup when completeUpload fails", async () => {
    const h = makeHarness();
    await h.controller.start([primarySpec()], START_OPTS);
    h.uploadApi.completeUpload.mockRejectedValueOnce(new Error("complete 500"));

    const result = await h.controller.stop();

    expect(result).toEqual({ stopped: true, anyCompleted: false });
    expect(h.backupStore.clearBackup).not.toHaveBeenCalled();
    expect(h.backupStore.markBackupFailed).toHaveBeenCalledWith(
      "session-1:segment-primary",
      expect.anything(),
    );
    expect(h.events.recovery.at(-1)?.state).toBe("failed");
  });

  it("surfaces a clear failure without dropping the manifest", async () => {
    const h = makeHarness();
    await h.controller.start([primarySpec()], START_OPTS);
    h.backupStore.clearBackup.mockRejectedValueOnce(new Error("clear failed"));

    const result = await h.controller.stop();

    // The track itself completed; only the local cleanup failed.
    expect(result).toEqual({ stopped: true, anyCompleted: true });
    expect(h.events.errors.at(-1)).toBe("clear failed");
    // The last surfaced manifest is still the available one, not null.
    expect(h.events.recovery.at(-1)).not.toBeNull();
  });

  it("surfaces an upload error even when the slot never had a backup", async () => {
    const h = makeHarness();
    h.backupStore.startBackup.mockRejectedValueOnce(new Error("no storage"));
    await h.controller.start([primarySpec()], START_OPTS);
    h.uploadApi.completeUpload.mockRejectedValueOnce(new Error("complete 500"));

    const result = await h.controller.stop();

    expect(result.anyCompleted).toBe(false);
    expect(h.backupStore.markBackupFailed).not.toHaveBeenCalled();
    expect(h.events.errors.at(-1)).toBe("complete 500");
  });

  it("computes per-slot durations from recorder start to stop", async () => {
    const h = makeHarness();
    await h.controller.start([slotSpec(1), slotSpec(2)], START_OPTS);
    h.advance(45_000);

    await h.controller.stop();

    for (const segment of [
      "segment-host-local-ch-1",
      "segment-host-local-ch-2",
    ]) {
      const call = h.backupStore.markBackupAvailable.mock.calls.find(
        ([id]) => id === `session-1:${segment}`,
      );
      expect(call?.[1]).toBe(45_000);
    }
    for (const call of h.uploadApi.completeUpload.mock.calls) {
      expect(call[2]).toBe(45_000);
    }
  });

  it("emits timing events across the take", async () => {
    const h = makeHarness();
    await h.controller.start([primarySpec()], START_OPTS);
    h.recorders[0].emit(new Blob(["chunk-a"], { type: "audio/webm" }), 0);
    await settle();
    await h.controller.stop();

    const eventNames = h.events.timing.map((event) => event.event);
    expect(eventNames).toContain("record-start");
    expect(eventNames).toContain("chunk");
    expect(eventNames).toContain("record-stop");
  });

  it("holds a stop that lands mid-start until startup settles, then stops the slots", async () => {
    const h = makeHarness();
    const presignGate = deferred<void>();
    h.uploadApi.getPresignedUploadTarget.mockImplementationOnce((async () => {
      await presignGate.promise;
      return {
        url: "https://s3.test/primary/0.webm",
        recordingToken: "token-primary",
        trackId: "track-primary",
        segmentId: "segment-primary",
      };
    }) as never);

    const startPromise = h.controller.start([primarySpec()], START_OPTS);
    await settle();
    expect(h.controller.active).toBe(true);

    // The room stops while our start is still blocked in presign. The stop
    // must not be dropped — and the eventual start must not resurrect the
    // recording after the room stopped (Codex P1 on PR #165).
    const stopPromise = h.controller.stop();
    await settle();
    expect(h.uploadApi.completeUpload).not.toHaveBeenCalled();

    presignGate.resolve();
    const [startResult, stopResult] = await Promise.all([
      startPromise,
      stopPromise,
    ]);

    // The caller is told a stop is already pending so it must not flip the
    // studio into the recording state.
    expect(startResult).toEqual({ ok: true, stopPending: true });
    expect(h.controller.recording).toBe(false);
    // The slot really started, then the held stop finalized it.
    expect(stopResult).toEqual({ stopped: true, anyCompleted: true });
    expect(h.recorders[0].started).toBe(true);
    expect(h.recorders[0].stopped).toBe(true);
    expect(h.uploadApi.completeUpload).toHaveBeenCalledTimes(1);
    expect(h.controller.active).toBe(false);
  });

  it("holds a stop that lands while a recorder is still starting", async () => {
    // Slot 2's recorder blocks in start(); slot 1 is already capturing.
    const h = makeHarness({ gateRecorderStartAt: 1 });

    const startPromise = h.controller.start([slotSpec(1), slotSpec(2)], START_OPTS);
    await settle();

    const stopPromise = h.controller.stop();
    await settle();
    expect(h.recorders[0].stopped).toBe(false);

    h.releaseRecorderStart();
    const [startResult, stopResult] = await Promise.all([
      startPromise,
      stopPromise,
    ]);

    expect(startResult).toEqual({ ok: true, stopPending: true });
    expect(stopResult).toEqual({ stopped: true, anyCompleted: true });
    expect(h.recorders.every((recorder) => recorder.stopped)).toBe(true);
    const completed = h.uploadApi.completeUpload.mock.calls.map(
      (call) => call[1],
    );
    expect(completed).toContain("track-host-local-ch-1");
    expect(completed).toContain("track-host-local-ch-2");
    expect(h.controller.active).toBe(false);
  });

  it("resolves a mid-start stop as a no-op when the start itself fails", async () => {
    const h = makeHarness();
    const presignGate = deferred<void>();
    h.uploadApi.getPresignedUploadTarget.mockImplementationOnce((async () => {
      await presignGate.promise;
      throw new Error("presign failed");
    }) as never);

    const startPromise = h.controller.start([primarySpec()], START_OPTS);
    await settle();
    const stopPromise = h.controller.stop();
    presignGate.resolve();

    const [startResult, stopResult] = await Promise.all([
      startPromise,
      stopPromise,
    ]);

    expect(startResult).toEqual({ ok: false, stage: "presign" });
    expect(stopResult).toEqual({ stopped: false, anyCompleted: false });
    expect(h.controller.active).toBe(false);
  });

  it("only one of two stops racing a mid-flight start performs the stop", async () => {
    const h = makeHarness();
    const presignGate = deferred<void>();
    h.uploadApi.getPresignedUploadTarget.mockImplementationOnce((async () => {
      await presignGate.promise;
      return {
        url: "https://s3.test/primary/0.webm",
        recordingToken: "token-primary",
        trackId: "track-primary",
        segmentId: "segment-primary",
      };
    }) as never);

    const startPromise = h.controller.start([primarySpec()], START_OPTS);
    await settle();
    const firstStop = h.controller.stop();
    const secondStop = h.controller.stop();
    presignGate.resolve();

    const [first, second] = await Promise.all([firstStop, secondStop]);
    await startPromise;

    const performed = [first, second].filter((result) => result.stopped);
    expect(performed).toHaveLength(1);
    expect(h.uploadApi.completeUpload).toHaveBeenCalledTimes(1);
  });

  it("allows a fresh start after a completed stop", async () => {
    const h = makeHarness();
    await h.controller.start([primarySpec()], START_OPTS);
    await h.controller.stop();

    const again = await h.controller.start([primarySpec()], START_OPTS);

    expect(again).toEqual({ ok: true });
    expect(h.recorders).toHaveLength(2);
    expect(h.tracker.reset).toHaveBeenCalledTimes(2);
  });
});

describe("RecordingLifecycleController stop settlement", () => {
  it("reports allCompleted when every slot confirms server-side", async () => {
    const h = makeHarness();
    await h.controller.start([slotSpec(1), slotSpec(2)], START_OPTS);

    await h.controller.stop();

    expect(h.events.stopSettled).toEqual([{ allCompleted: true }]);
  });

  it("reports allCompleted false when any slot's completion fails", async () => {
    const h = makeHarness();
    h.uploadApi.completeUpload.mockRejectedValueOnce(
      new Error("complete failed"),
    );
    await h.controller.start([slotSpec(1), slotSpec(2)], START_OPTS);

    await h.controller.stop();

    expect(h.events.stopSettled).toEqual([{ allCompleted: false }]);
  });

  it("keeps allCompleted true when only verified-backup cleanup fails", async () => {
    // The track is confirmed on the server; a failed local clearBackup is a
    // housekeeping error and must not read as an unconfirmed upload.
    const h = makeHarness();
    h.backupStore.clearBackup.mockRejectedValueOnce(new Error("idb wedged"));
    await h.controller.start([primarySpec()], START_OPTS);

    const result = await h.controller.stop();

    expect(result.anyCompleted).toBe(true);
    expect(h.events.stopSettled).toEqual([{ allCompleted: true }]);
  });

  it("does not fire when there was nothing to stop", async () => {
    const h = makeHarness();

    await h.controller.stop();

    expect(h.events.stopSettled).toEqual([]);
  });
});
