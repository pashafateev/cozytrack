"use client";

// Unified slot recording lifecycle (issue #135 refactor).
//
// One recording take = N independent "slots", each owning a stream → recorder
// → chunked upload → local backup pipeline against its own server track.
// Single-track mode is the degenerate 1-slot case; two-channel local mode
// passes 2 slots. Both studio modes drive this controller so the pipeline can
// never diverge between them again (the failure mode PR #159 review kept
// finding).
//
// This is deliberately a plain object, NOT a React hook: the studio's level
// meters run continuous rAF loops that keep React perpetually "busy", so
// hook-based lifecycles can't be exercised with act(async) in tests. All
// React state surfacing goes through injected callbacks instead.
//
// Invariants owned here:
//  1. Per-channel independence at every stage — stop, drain, final upload,
//     complete, and backup ops are settled per slot, so one channel's failure
//     never aborts a sibling.
//  2. Every in-flight upload drains before any completeUpload (/complete
//     deletes the temporary chunk objects server-side).
//  3. markBackupAvailable(durationMs) lands before the final upload, so a
//     crash mid-upload still recovers with a correct duration.
//  4. Every backup state change surfaces through the recovery callbacks so
//     the studio's recovery panel can render in-session.
//  5. Partial-start rollback finalizes already-started slots — no server
//     track is left recording after a failed start.
//  6. Crash-safe backup order: startBackup → saveChunk →
//     markChunkUploaded/Failed → markBackupAvailable(duration) →
//     clearBackup/markBackupFailed.

import { v4 as uuidv4 } from "uuid";
import {
  recordingBackupId,
  type RecordingBackupManifest,
  type RecordingBackupClearReason,
  type StartRecordingBackupInput,
} from "@/lib/recording-backup";
import type { DeviceInfo, PresignedUploadTarget, TrackInitInfo } from "@/lib/upload";

/** The final merged recording.webm is uploaded under this part number. */
export const FINAL_RECORDING_PART_NUMBER = 9999;

const DEFAULT_TIME_SLICE_MS = 5000;

export interface RecorderLike {
  onChunk(callback: (chunk: Blob, index: number) => void): void;
  start(timeSliceMs?: number): Promise<void>;
  stop(): Promise<Blob>;
}

export interface RecordingUploadApi {
  getPresignedUploadTarget(
    sessionId: string,
    trackId: string,
    partNumber: number,
    participantName?: string,
    trackInit?: TrackInitInfo,
    recordingToken?: string,
  ): Promise<PresignedUploadTarget>;
  getPresignedUploadUrl(
    sessionId: string,
    trackId: string,
    partNumber: number,
    participantName?: string,
    trackInit?: TrackInitInfo,
    recordingToken?: string,
  ): Promise<string>;
  uploadChunk(url: string, chunk: Blob): Promise<void>;
  completeUpload(
    sessionId: string,
    trackId: string,
    durationMs?: number,
    recordingToken?: string,
    segmentId?: string,
  ): Promise<void>;
}

export interface RecordingBackupStoreLike {
  startBackup(input: StartRecordingBackupInput): Promise<RecordingBackupManifest>;
  saveChunk(input: {
    sessionId: string;
    trackId: string;
    segmentId?: string;
    chunkIndex: number;
    chunk: Blob;
    capturedAt?: Date;
  }): Promise<RecordingBackupManifest>;
  markChunkUploaded(
    sessionId: string,
    trackId: string,
    chunkIndex: number,
    segmentId?: string,
  ): Promise<RecordingBackupManifest>;
  markChunkFailed(
    sessionId: string,
    trackId: string,
    chunkIndex: number,
    error: unknown,
    segmentId?: string,
  ): Promise<RecordingBackupManifest>;
  markBackupAvailable(
    id: string,
    durationMs?: number,
  ): Promise<RecordingBackupManifest>;
  markBackupFailed(id: string, error: unknown): Promise<RecordingBackupManifest>;
  clearBackup(id: string, reason: RecordingBackupClearReason): Promise<void>;
}

/**
 * The subset of useUploadProgress the lifecycle drives. All callbacks are
 * identity-stable in the real hook, so a controller built once can hold them.
 */
export interface RecordingUploadTrackerLike {
  reset(): void;
  onChunkRecorded(byteLength: number): void;
  trackUpload(
    byteLength: number,
    uploadPromise: Promise<void>,
    options?: { rethrow?: boolean },
  ): Promise<void>;
  freezeRecorded(): void;
  waitForUploads(): Promise<void>;
}

/** One channel to record: a stream plus the identity its track is filed under. */
export interface RecordingSlotSpec {
  /**
   * Host-local channel slot id (two-channel mode). Omitted for the primary
   * single-track mic recording.
   */
  localTrackSlotId?: string;
  /** Participant name recorded on the server track and backup manifest. */
  participantName: string;
  stream: MediaStream;
  deviceInfo: DeviceInfo;
}

export interface RecordingLifecycleCallbacks {
  /**
   * Latest recovery-relevant backup manifest across all slots, or null when
   * none remains. Failed manifests win over the latest state change so one
   * slot's verified-upload clear can never hide a sibling's kept backup.
   */
  onRecoveryBackup?(manifest: RecordingBackupManifest | null): void;
  /** Latest backup error message across all slots, or null when cleared. */
  onBackupError?(message: string | null): void;
  /** A slot's local backup could not be initialized; recording continues remote-only. */
  onBackupUnavailable?(spec: RecordingSlotSpec): void;
  /** Structured timing diagnostics (issue #7's ?timing=1 instrumentation). */
  onTiming?(event: Record<string, unknown>): void;
  /**
   * A stop finished finalizing every slot. `allCompleted` is true only when
   * every slot's track confirmed server-side (completeUpload acked) — local
   * backup housekeeping failures do not affect it. Not fired by a no-op stop.
   * This is the authoritative "is any of this take's audio unconfirmed"
   * signal; backup manifests/errors also cover unrelated store failures, so
   * they must not be used for that.
   */
  onStopSettled?(outcome: { allCompleted: boolean }): void;
}

export interface RecordingLifecycleDeps {
  sessionId: string;
  uploadApi: RecordingUploadApi;
  backupStore: RecordingBackupStoreLike;
  tracker: RecordingUploadTrackerLike;
  createRecorder(stream: MediaStream): RecorderLike;
  generateTrackId?(): string;
  now?(): number;
  callbacks?: RecordingLifecycleCallbacks;
}

export interface RecordingStartOptions {
  /** ISO8601 originator clock shared by every track in the take. */
  sessionStartedAt: string;
  takeId?: string | null;
  timeSliceMs?: number;
}

export type RecordingStartFailureStage =
  | "already-active"
  | "no-slots"
  | "presign"
  | "recorder-start";

export type RecordingStartResult =
  | {
      ok: true;
      /**
       * A stop() arrived while the slots were still starting. It is already
       * waiting inside the controller and will finalize the take; the caller
       * must NOT treat the studio as recording.
       */
      stopPending?: boolean;
    }
  | { ok: false; stage: RecordingStartFailureStage };

export interface RecordingStopResult {
  /** False when there was nothing to stop (idle or already stopping). */
  stopped: boolean;
  /** True when at least one slot's track fully completed. */
  anyCompleted: boolean;
}

type SlotState = {
  /** Stable key for backup-surfacing maps; "primary" for single-track. */
  key: string;
  spec: RecordingSlotSpec;
  recorder: RecorderLike;
  trackId: string;
  segmentId: string;
  uploadToken: string | undefined;
  /** Null when startBackup failed — every backup op is skipped for the slot. */
  backupId: string | null;
  /** Stamped immediately before recorder.start(). */
  startedAtMs: number;
};

/** Tags a start failure with the pipeline stage that caused it. */
class SlotStartError extends Error {
  constructor(
    readonly stage: "presign" | "recorder-start",
    cause: unknown,
  ) {
    super(`Recording slot failed to start at ${stage}`, { cause });
  }
}

function backupErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Local recording backup failed";
}

export class RecordingLifecycleController {
  private phase: "idle" | "starting" | "recording" | "stopping" = "idle";
  private slots: SlotState[] = [];
  // The in-flight start attempt (never rejects), so a stop() that lands
  // mid-start can wait for startup to settle instead of being dropped.
  private startAttempt: Promise<unknown> | null = null;
  private stopRequestedWhileStarting = false;
  // Monotonic sequence for backup surfacing so aggregation can order state
  // changes without trusting manifest timestamps.
  private surfaceSeq = 0;
  private slotManifests = new Map<
    string,
    { seq: number; manifest: RecordingBackupManifest | null }
  >();
  private slotErrors = new Map<string, { seq: number; message: string | null }>();

  constructor(private readonly deps: RecordingLifecycleDeps) {}

  /** True from the moment a start is attempted until the take fully settles. */
  get active(): boolean {
    return this.phase !== "idle";
  }

  /** True only while slots are actually capturing (start settled, stop not begun). */
  get recording(): boolean {
    return this.phase === "recording";
  }

  async start(
    specs: RecordingSlotSpec[],
    options: RecordingStartOptions,
  ): Promise<RecordingStartResult> {
    if (this.phase !== "idle") return { ok: false, stage: "already-active" };
    if (specs.length === 0) return { ok: false, stage: "no-slots" };
    this.phase = "starting";
    this.stopRequestedWhileStarting = false;

    const attempt = this.beginAllSlots(specs, options);
    // Held for stop(): a stop that lands mid-start waits on this (the derived
    // promise never rejects) and then stops whatever actually started.
    this.startAttempt = attempt.then(
      () => undefined,
      () => undefined,
    );
    try {
      const result = await attempt;
      if (result.ok && this.stopRequestedWhileStarting) {
        // Deterministic signal regardless of microtask ordering: the stop was
        // requested before startup settled, so the caller must not flip into
        // the recording state — the waiting stop() finalizes the take.
        return { ok: true, stopPending: true };
      }
      return result;
    } finally {
      this.startAttempt = null;
      this.stopRequestedWhileStarting = false;
    }
  }

  private async beginAllSlots(
    specs: RecordingSlotSpec[],
    options: RecordingStartOptions,
  ): Promise<RecordingStartResult> {
    this.deps.tracker.reset();
    this.slotManifests.clear();
    this.slotErrors.clear();

    const timeSliceMs = options.timeSliceMs ?? DEFAULT_TIME_SLICE_MS;
    const started: SlotState[] = [];
    try {
      // Sequential on purpose: slot ordering is part of the server contract
      // (deterministic track creation order) and a failure must roll back only
      // the slots that actually started.
      for (const spec of specs) {
        started.push(await this.beginSlot(spec, options, timeSliceMs));
      }
    } catch (err) {
      console.error("Failed to start recording slots:", err);
      await this.rollbackPartialStart(started);
      this.phase = "idle";
      return {
        ok: false,
        stage: err instanceof SlotStartError ? err.stage : "recorder-start",
      };
    }

    // The phase must flip before this promise resolves so a stop() waiting on
    // the attempt observes "recording" and proceeds.
    this.slots = started;
    this.phase = "recording";
    return { ok: true };
  }

  async stop(): Promise<RecordingStopResult> {
    // A stop that lands while the take is still starting must not be dropped:
    // wait for startup to settle, then stop whatever actually started. The
    // start() caller is told via stopPending that this stop owns the take.
    if (this.phase === "starting") {
      this.stopRequestedWhileStarting = true;
      if (this.startAttempt) await this.startAttempt;
    }
    if (this.phase !== "recording") {
      return { stopped: false, anyCompleted: false };
    }
    this.phase = "stopping";
    const slots = this.slots;
    this.slots = [];

    try {
      // Stop every recorder independently — one channel dying mid-stop must
      // not cost the sibling its capture.
      const stopResults = await Promise.allSettled(
        slots.map((slot) => slot.recorder.stop()),
      );
      const stoppedAtMs = this.now();
      // Recording is done: freeze the progress denominator (the final merged
      // blobs below still grow it explicitly).
      this.deps.tracker.freezeRecorded();

      const outcomes = await Promise.allSettled(
        slots.map((slot, index) => {
          const stopResult = stopResults[index];
          if (stopResult.status === "rejected") {
            console.error(
              `Failed to stop recorder for slot ${slot.key}:`,
              stopResult.reason,
            );
            return this.handleSlotFailure(slot, stopResult.reason).then(
              () => false,
            );
          }
          return this.finalizeSlot(
            slot,
            stopResult.value,
            stoppedAtMs - slot.startedAtMs,
          );
        }),
      );
      this.deps.callbacks?.onStopSettled?.({
        allCompleted: outcomes.every(
          (outcome) => outcome.status === "fulfilled" && outcome.value === true,
        ),
      });
      return {
        stopped: true,
        anyCompleted: outcomes.some(
          (outcome) => outcome.status === "fulfilled" && outcome.value === true,
        ),
      };
    } finally {
      // Do not report idle until the chunk-upload promise set is drained,
      // regardless of error path (issue #61's finalizing invariant).
      try {
        await this.deps.tracker.waitForUploads();
      } catch (drainErr) {
        console.error("Failed while draining chunk uploads:", drainErr);
      }
      this.phase = "idle";
    }
  }

  // ---- Start pipeline ----

  private async beginSlot(
    spec: RecordingSlotSpec,
    options: RecordingStartOptions,
    timeSliceMs: number,
  ): Promise<SlotState> {
    const key = spec.localTrackSlotId ?? "primary";
    const requestedTrackId = this.generateTrackId();

    let target: PresignedUploadTarget;
    try {
      target = await this.deps.uploadApi.getPresignedUploadTarget(
        this.deps.sessionId,
        requestedTrackId,
        0,
        spec.participantName,
        {
          deviceInfo: spec.deviceInfo,
          sessionStartedAt: options.sessionStartedAt,
          takeId: options.takeId ?? undefined,
          localTrackSlotId: spec.localTrackSlotId,
        },
      );
    } catch (err) {
      console.error("Failed to initialize upload:", err);
      throw new SlotStartError("presign", err);
    }
    const trackId = target.trackId ?? requestedTrackId;
    const segmentId = target.segmentId ?? requestedTrackId;
    const uploadToken = target.recordingToken;

    let backupId: string | null = null;
    try {
      const backup = await this.deps.backupStore.startBackup({
        sessionId: this.deps.sessionId,
        trackId,
        segmentId,
        participantName: spec.participantName,
        recordingToken: uploadToken,
      });
      backupId = recordingBackupId(this.deps.sessionId, segmentId);
      this.surfaceManifest(key, backup ?? null);
      this.surfaceError(key, null);
    } catch (backupErr) {
      console.error("Failed to initialize local recording backup:", backupErr);
      this.surfaceManifest(key, null);
      this.surfaceError(key, backupErrorMessage(backupErr));
      this.deps.callbacks?.onBackupUnavailable?.(spec);
    }

    const recorder = this.deps.createRecorder(spec.stream);
    const slot: SlotState = {
      key,
      spec,
      recorder,
      trackId,
      segmentId,
      uploadToken,
      backupId,
      startedAtMs: 0,
    };
    recorder.onChunk((chunk, index) => this.handleChunk(slot, chunk, index));

    slot.startedAtMs = this.now();
    this.deps.callbacks?.onTiming?.({
      event: "record-start",
      t: slot.startedAtMs,
      sessionStartedAt: options.sessionStartedAt,
      trackId,
      participant: spec.participantName,
    });
    try {
      await recorder.start(timeSliceMs);
    } catch (err) {
      console.error("Failed to start recorder:", err);
      // The presign above already created a server track for this slot, and a
      // slot that never reaches `started` is skipped by the rollback. Conclude
      // it here so the row can't sit in `recording` forever.
      await this.concludeAbandonedSlot(slot);
      throw new SlotStartError("recorder-start", err);
    }
    return slot;
  }

  /**
   * Converge the server track of a slot that presigned but never recorded:
   * completing with no uploaded artifact drives materialization to mark the
   * track failed, which — unlike a row stuck in `recording` — does not block
   * session finalize. Only safe for slots with no recording data; a slot that
   * captured anything keeps its track open so the uploaded chunks and local
   * backup stay recoverable (/complete deletes the segment's chunk objects).
   */
  private async concludeAbandonedSlot(slot: SlotState): Promise<void> {
    try {
      // Nothing of this slot's can be in flight, but the drain-before-complete
      // invariant is cheap to keep uniform across every completeUpload.
      await this.deps.tracker.waitForUploads();
      await this.deps.uploadApi.completeUpload(
        this.deps.sessionId,
        slot.trackId,
        undefined,
        slot.uploadToken,
        slot.segmentId,
      );
    } catch (concludeErr) {
      console.error(
        `Failed to conclude abandoned slot ${slot.key} server-side:`,
        concludeErr,
      );
    }
  }

  /**
   * A slot failed to start after siblings already began: stop and finalize
   * each started slot through the normal path so no server track lingers in
   * `recording` waiting on recovery. Best-effort — a slot whose recorder
   * cannot even stop has nothing to finalize.
   */
  private async rollbackPartialStart(started: SlotState[]): Promise<void> {
    if (started.length === 0) return;
    this.deps.tracker.freezeRecorded();
    await Promise.allSettled(
      started.map(async (slot) => {
        let blob: Blob | null = null;
        try {
          blob = await slot.recorder.stop();
        } catch (stopErr) {
          console.error("Failed to stop partial slot recorder:", stopErr);
          // No blob to finalize, but data may already be at risk (uploaded
          // chunks + local backup), so the server track deliberately stays
          // open for recovery — concluding it would let /complete delete the
          // chunk objects. Keep + surface the backup so the recovery panel
          // can re-drive the track in-session.
          await this.handleSlotFailure(slot, stopErr);
        }
        if (blob) {
          await this.finalizeSlot(slot, blob, this.now() - slot.startedAtMs);
        }
      }),
    );
    try {
      await this.deps.tracker.waitForUploads();
    } catch (drainErr) {
      console.error("Failed while draining partial slot uploads:", drainErr);
    }
  }

  // ---- Chunk pipeline ----

  private handleChunk(slot: SlotState, chunk: Blob, index: number): void {
    const byteLength = chunk.size;
    this.deps.tracker.onChunkRecorded(byteLength);
    this.deps.callbacks?.onTiming?.({
      event: "chunk",
      t: this.now(),
      trackId: slot.trackId,
      chunkIndex: index,
      chunkBytes: byteLength,
    });

    const capturedAt = new Date();
    // Crash safety: the local write is sequenced before the remote PUT so a
    // tab crash mid-upload still has the chunk on disk.
    const backupSave: Promise<RecordingBackupManifest | null> = slot.backupId
      ? this.deps.backupStore
          .saveChunk({
            sessionId: this.deps.sessionId,
            trackId: slot.trackId,
            segmentId: slot.segmentId,
            chunkIndex: index,
            chunk,
            capturedAt,
          })
          .then((backup) => {
            this.surfaceManifest(slot.key, backup ?? null);
            this.surfaceError(slot.key, null);
            return backup ?? null;
          })
          .catch((backupErr) => {
            console.error("Failed to write local recording backup:", backupErr);
            this.surfaceError(slot.key, backupErrorMessage(backupErr));
            return null;
          })
      : Promise.resolve(null);

    const uploadPromise = (async () => {
      const savedBackup = await backupSave;
      try {
        const url = await this.deps.uploadApi.getPresignedUploadUrl(
          this.deps.sessionId,
          slot.trackId,
          index,
          undefined,
          { segmentId: slot.segmentId },
          slot.uploadToken,
        );
        await this.deps.uploadApi.uploadChunk(url, chunk);
      } catch (uploadErr) {
        if (savedBackup) {
          try {
            const backup = await this.deps.backupStore.markChunkFailed(
              this.deps.sessionId,
              slot.trackId,
              index,
              uploadErr,
              slot.segmentId,
            );
            this.surfaceManifest(slot.key, backup ?? null);
          } catch (backupErr) {
            console.error("Failed to mark local backup chunk failed:", backupErr);
          }
        }
        throw uploadErr;
      }
      if (savedBackup) {
        try {
          const backup = await this.deps.backupStore.markChunkUploaded(
            this.deps.sessionId,
            slot.trackId,
            index,
            slot.segmentId,
          );
          this.surfaceManifest(slot.key, backup ?? null);
        } catch (backupErr) {
          console.error("Failed to mark local backup chunk uploaded:", backupErr);
          this.surfaceError(slot.key, backupErrorMessage(backupErr));
        }
      }
    })();

    void this.deps.tracker.trackUpload(byteLength, uploadPromise);
  }

  // ---- Stop pipeline ----

  /**
   * Finalize one slot's track: hand the backup its duration, upload the final
   * recording.webm, drain, mark the track complete, and clear the backup.
   * Contained per slot — a failure here (backup kept + marked failed) can
   * never prevent a sibling channel from finalizing. Returns true iff the
   * track completed.
   */
  private async finalizeSlot(
    slot: SlotState,
    blob: Blob,
    durationMs: number,
  ): Promise<boolean> {
    this.deps.callbacks?.onTiming?.({
      event: "record-stop",
      t: this.now(),
      trackId: slot.trackId,
      startedAt: slot.startedAtMs,
      durationMs,
      finalBlobBytes: blob.size,
    });

    // Before the final upload, so a crash mid-upload still recovers this
    // track with a correct duration instead of null.
    if (slot.backupId) {
      try {
        const backup = await this.deps.backupStore.markBackupAvailable(
          slot.backupId,
          durationMs,
        );
        this.surfaceManifest(slot.key, backup ?? null);
      } catch (backupErr) {
        console.error("Failed to mark local backup available:", backupErr);
      }
    }

    // The final recording.webm upload is critical: if it fails, we must NOT
    // call completeUpload (which lets the server delete chunk files). The
    // rethrow surfaces the failure here so completeUpload is skipped and the
    // tracker's lastError feeds the UI.
    const finalBytes = blob.size;
    this.deps.tracker.onChunkRecorded(finalBytes);
    const finalUpload = (async () => {
      const url = await this.deps.uploadApi.getPresignedUploadUrl(
        this.deps.sessionId,
        slot.trackId,
        FINAL_RECORDING_PART_NUMBER,
        undefined,
        { segmentId: slot.segmentId },
        slot.uploadToken,
      );
      await this.deps.uploadApi.uploadChunk(url, blob);
    })();

    try {
      await this.deps.tracker.trackUpload(finalBytes, finalUpload, {
        rethrow: true,
      });
      // Drain every in-flight upload (all slots' background chunk PUTs and
      // final blobs) before completing — /complete deletes the temporary
      // chunk objects, so a slow chunk PUT landing afterwards would strand
      // stale objects.
      await this.deps.tracker.waitForUploads();
      await this.deps.uploadApi.completeUpload(
        this.deps.sessionId,
        slot.trackId,
        durationMs,
        slot.uploadToken,
        slot.segmentId,
      );
      if (slot.backupId) {
        try {
          await this.deps.backupStore.clearBackup(
            slot.backupId,
            "verified-upload",
          );
          this.surfaceManifest(slot.key, null);
          this.surfaceError(slot.key, null);
        } catch (backupErr) {
          console.error("Failed to clear uploaded local backup:", backupErr);
          this.surfaceError(slot.key, backupErrorMessage(backupErr));
        }
      }
      return true;
    } catch (err) {
      console.error(`Failed to finalize recording slot ${slot.key}:`, err);
      await this.handleSlotFailure(slot, err);
      return false;
    }
  }

  /** Keep the slot's backup for recovery and surface the failure in-session. */
  private async handleSlotFailure(slot: SlotState, err: unknown): Promise<void> {
    if (slot.backupId) {
      try {
        const backup = await this.deps.backupStore.markBackupFailed(
          slot.backupId,
          err,
        );
        this.surfaceManifest(slot.key, backup ?? null);
        this.surfaceError(slot.key, null);
      } catch (backupErr) {
        console.error("Failed to mark local backup failed:", backupErr);
        this.surfaceError(slot.key, backupErrorMessage(backupErr));
      }
    } else {
      // No local backup for this channel — at least tell the host the upload
      // failed rather than failing silently.
      this.surfaceError(slot.key, backupErrorMessage(err));
    }
  }

  // ---- Backup surfacing ----
  //
  // The studio renders ONE recovery panel, so N slots project onto a single
  // manifest + error. Each slot's latest state is kept per-slot and aggregated
  // on every change: failed manifests beat the most recent update, so a
  // sibling's verified-upload clear can never hide a kept backup.

  private surfaceManifest(
    key: string,
    manifest: RecordingBackupManifest | null,
  ): void {
    this.surfaceSeq += 1;
    this.slotManifests.set(key, { seq: this.surfaceSeq, manifest });
    this.deps.callbacks?.onRecoveryBackup?.(this.aggregateManifest());
  }

  private aggregateManifest(): RecordingBackupManifest | null {
    const present = Array.from(this.slotManifests.values()).filter(
      (entry): entry is { seq: number; manifest: RecordingBackupManifest } =>
        entry.manifest !== null,
    );
    if (present.length === 0) return null;
    const failed = present.filter((entry) => entry.manifest.state === "failed");
    const pool = failed.length > 0 ? failed : present;
    return pool.reduce((latest, entry) =>
      entry.seq > latest.seq ? entry : latest,
    ).manifest;
  }

  private surfaceError(key: string, message: string | null): void {
    this.surfaceSeq += 1;
    this.slotErrors.set(key, { seq: this.surfaceSeq, message });
    const present = Array.from(this.slotErrors.values()).filter(
      (entry): entry is { seq: number; message: string } =>
        entry.message !== null,
    );
    const aggregate =
      present.length > 0
        ? present.reduce((latest, entry) =>
            entry.seq > latest.seq ? entry : latest,
          ).message
        : null;
    this.deps.callbacks?.onBackupError?.(aggregate);
  }

  // ---- Small injectable utilities ----

  private generateTrackId(): string {
    return this.deps.generateTrackId?.() ?? uuidv4();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
