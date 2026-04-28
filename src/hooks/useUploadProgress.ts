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

export interface UploadTracker {
  /** Current snapshot of upload progress. */
  progress: UploadProgress;
  /** Call when recorder emits a new chunk (before upload starts). */
  onChunkRecorded: (byteLength: number) => void;
  /** Wrap a chunk upload promise so it tracks bytes and in-flight count. */
  trackUpload: (byteLength: number, uploadPromise: Promise<void>) => Promise<void>;
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
    (byteLength: number, uploadPromise: Promise<void>): Promise<void> => {
      inFlight.current += 1;
      flush();

      const tracked = uploadPromise
        .then(() => {
          uploaded.current += byteLength;
          // Clear last error on success.
          setProgress((prev) =>
            prev.lastError !== null ? { ...prev, lastError: null } : prev,
          );
        })
        .catch((err: unknown) => {
          const message =
            err instanceof Error ? err.message : "Upload failed";
          setProgress((prev) => ({ ...prev, lastError: message }));
        })
        .finally(() => {
          inFlight.current -= 1;
          inflightPromises.current.delete(tracked);
          flush();
        });

      inflightPromises.current.add(tracked);
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
