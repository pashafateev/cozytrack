"use client";

import { useCallback, useRef, useState } from "react";

export interface UploadProgress {
  /** Total bytes from recorder chunks emitted so far. */
  bytesRecorded: number;
  /** Total bytes acknowledged by S3 (successful PUT responses). */
  bytesUploaded: number;
  /** Number of chunk uploads currently in flight. */
  chunksInFlight: number;
  /** Last upload error, if any. Cleared on next successful upload. */
  lastError: string | null;
  /** Whether the upload pipeline has any work remaining. */
  hasInflight: boolean;
  /** Fraction 0..1 of upload completion. 0 when nothing recorded. */
  fraction: number;
}

export interface TrackUploadOptions {
  /**
   * If true, rethrow the upload error after recording it in `lastError`.
   * Use for critical uploads (e.g. final recording.webm) where the caller
   * needs to abort follow-up actions on failure. Defaults to false so
   * background chunk uploads don't produce unhandled rejections.
   */
  rethrow?: boolean;
}

export interface UploadTracker {
  /** Current snapshot of upload progress. */
  progress: UploadProgress;
  /** Call when recorder emits a new chunk (before upload starts). */
  onChunkRecorded: (byteLength: number) => void;
  /** Wrap a chunk upload promise so it tracks bytes and in-flight count. */
  trackUpload: (
    byteLength: number,
    uploadPromise: Promise<void>,
    options?: TrackUploadOptions,
  ) => Promise<void>;
  /** Freeze the denominator — call when recording stops. */
  freezeRecorded: () => void;
  /** Reset all counters for a new recording session. */
  reset: () => void;
  /** Wait until all in-flight uploads complete. */
  waitForUploads: () => Promise<void>;
  /** Whether uploads are pending (for beforeunload). */
  hasInflight: boolean;
}

export function useUploadProgress(): UploadTracker {
  const [progress, setProgress] = useState<UploadProgress>({
    bytesRecorded: 0,
    bytesUploaded: 0,
    chunksInFlight: 0,
    lastError: null,
    hasInflight: false,
    fraction: 0,
  });

  // Mutable counters for synchronous access (avoid stale closure issues).
  const recorded = useRef(0);
  const uploaded = useRef(0);
  const inFlight = useRef(0);
  const inflightPromises = useRef(new Set<Promise<void>>());

  const flush = useCallback(() => {
    const rec = recorded.current;
    const up = uploaded.current;
    const inf = inFlight.current;
    const fraction = rec > 0 ? Math.min(1, up / rec) : 0;
    setProgress((prev) => {
      // Only update if something changed to avoid unnecessary re-renders.
      if (
        prev.bytesRecorded === rec &&
        prev.bytesUploaded === up &&
        prev.chunksInFlight === inf &&
        prev.fraction === fraction &&
        prev.hasInflight === (inf > 0)
      ) {
        return prev;
      }
      return {
        bytesRecorded: rec,
        bytesUploaded: up,
        chunksInFlight: inf,
        lastError: prev.lastError,
        hasInflight: inf > 0,
        fraction,
      };
    });
  }, []);

  const onChunkRecorded = useCallback(
    (byteLength: number) => {
      recorded.current += byteLength;
      flush();
    },
    [flush],
  );

  const trackUpload = useCallback(
    (
      byteLength: number,
      uploadPromise: Promise<void>,
      options?: TrackUploadOptions,
    ): Promise<void> => {
      const rethrow = options?.rethrow ?? false;
      inFlight.current += 1;
      flush();

      // Build a tracker promise that always settles successfully so it can
      // live in `inflightPromises` without producing unhandled rejections —
      // independent of whether we rethrow to the caller.
      const settled: Promise<{ ok: true } | { ok: false; err: unknown }> =
        uploadPromise.then(
          () => ({ ok: true as const }),
          (err: unknown) => ({ ok: false as const, err }),
        );

      const tracked: Promise<void> = settled
        .then((result) => {
          if (result.ok) {
            uploaded.current += byteLength;
            setProgress((prev) =>
              prev.lastError !== null ? { ...prev, lastError: null } : prev,
            );
          } else {
            const message =
              result.err instanceof Error ? result.err.message : "Upload failed";
            setProgress((prev) => ({ ...prev, lastError: message }));
          }
        })
        .finally(() => {
          inFlight.current -= 1;
          inflightPromises.current.delete(tracked);
          flush();
        });

      inflightPromises.current.add(tracked);

      if (rethrow) {
        // Caller wants to abort on failure. Wait for tracking bookkeeping to
        // finish (so `lastError` is set and counters are decremented) before
        // surfacing the original error.
        return tracked.then(async () => {
          const result = await settled;
          if (!result.ok) {
            throw result.err instanceof Error
              ? result.err
              : new Error("Upload failed");
          }
        });
      }

      return tracked;
    },
    [flush],
  );

  const freezeRecorded = useCallback(() => {
    // Denominator is already whatever recorded.current is — just flush to
    // ensure state is in sync. After this, no more onChunkRecorded calls
    // should arrive, so the denominator freezes naturally.
    flush();
  }, [flush]);

  const reset = useCallback(() => {
    // Defensive: clearing inflightPromises while uploads are still running
    // would let those promises' .finally drive counters negative when they
    // settle. Callers must waitForUploads() (or otherwise reach an idle
    // state) before resetting. The finalizing-state invariant guarantees
    // this in practice — this guard catches programming mistakes.
    if (inFlight.current > 0) {
      console.warn(
        `useUploadProgress.reset() called with ${inFlight.current} uploads still in flight; ignoring.`,
      );
      return;
    }
    recorded.current = 0;
    uploaded.current = 0;
    inFlight.current = 0;
    inflightPromises.current.clear();
    setProgress({
      bytesRecorded: 0,
      bytesUploaded: 0,
      chunksInFlight: 0,
      lastError: null,
      hasInflight: false,
      fraction: 0,
    });
  }, []);

  const waitForUploads = useCallback(async () => {
    while (inflightPromises.current.size > 0) {
      await Promise.allSettled(Array.from(inflightPromises.current));
    }
  }, []);

  return {
    progress,
    onChunkRecorded,
    trackUpload,
    freezeRecorded,
    reset,
    waitForUploads,
    hasInflight: progress.hasInflight,
  };
}
