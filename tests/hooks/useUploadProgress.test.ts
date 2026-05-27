import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useUploadProgress, type UploadProgress } from "@/hooks/useUploadProgress";
import { getUploadPhase } from "@/lib/upload-progress";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function progress(overrides: Partial<UploadProgress>): UploadProgress {
  const bytesRecorded = overrides.bytesRecorded ?? 0;
  const bytesUploaded = overrides.bytesUploaded ?? 0;
  const chunksInFlight = overrides.chunksInFlight ?? 0;
  const lastError = overrides.lastError ?? null;
  return {
    bytesRecorded,
    bytesUploaded,
    chunksInFlight,
    lastError,
    hasInflight: overrides.hasInflight ?? chunksInFlight > 0,
    fraction:
      overrides.fraction ??
      (bytesRecorded > 0 ? Math.min(1, bytesUploaded / bytesRecorded) : 0),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useUploadProgress", () => {
  it("when recorded chunks upload successfully, uploaded bytes must equal recorded bytes with no chunks in flight", async () => {
    const { result } = renderHook(() => useUploadProgress());
    const uploads = [deferred(), deferred(), deferred()];
    const tracked: Promise<void>[] = [];

    act(() => {
      result.current.onChunkRecorded(100);
      result.current.onChunkRecorded(250);
      result.current.onChunkRecorded(50);
      tracked.push(result.current.trackUpload(100, uploads[0].promise));
      tracked.push(result.current.trackUpload(250, uploads[1].promise));
      tracked.push(result.current.trackUpload(50, uploads[2].promise));
    });

    await waitFor(() => {
      expect(result.current.progress.chunksInFlight).toBe(3);
    });

    await act(async () => {
      uploads.forEach((upload) => upload.resolve());
      await Promise.all(tracked);
    });

    expect(result.current.progress.bytesRecorded).toBe(400);
    expect(result.current.progress.bytesUploaded).toBe(400);
    expect(result.current.progress.chunksInFlight).toBe(0);
    expect(result.current.progress.hasInflight).toBe(false);
    expect(result.current.progress.fraction).toBe(1);
  });

  it("when chunks are recorded over a session, recorded bytes must never decrease", () => {
    const { result } = renderHook(() => useUploadProgress());

    for (const byteLength of [10, 0, 25, 100, 1]) {
      const before = result.current.progress.bytesRecorded;
      act(() => {
        result.current.onChunkRecorded(byteLength);
      });
      expect(result.current.progress.bytesRecorded).toBeGreaterThanOrEqual(before);
    }

    expect(result.current.progress.bytesRecorded).toBe(136);
  });

  it("when a rethrowing upload fails, in-flight bookkeeping must settle before the error surfaces", async () => {
    const { result } = renderHook(() => useUploadProgress());
    const upload = deferred();
    const error = new Error("S3 rejected the chunk");
    let tracked!: Promise<void>;
    let thrown: unknown;

    act(() => {
      result.current.onChunkRecorded(128);
      tracked = result.current.trackUpload(128, upload.promise, {
        rethrow: true,
      });
    });

    await waitFor(() => {
      expect(result.current.progress.chunksInFlight).toBe(1);
    });

    await act(async () => {
      upload.reject(error);
      try {
        await tracked;
      } catch (err) {
        thrown = err;
      }
    });

    expect(thrown).toBe(error);
    expect(result.current.progress.chunksInFlight).toBe(0);
    expect(result.current.progress.lastError).toBe("S3 rejected the chunk");
    expect(result.current.progress.hasInflight).toBe(false);
  });

  it("when reset runs with chunks in flight, counters must remain unchanged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useUploadProgress());
    const upload = deferred();
    let tracked!: Promise<void>;

    act(() => {
      result.current.onChunkRecorded(512);
      tracked = result.current.trackUpload(512, upload.promise);
    });

    await waitFor(() => {
      expect(result.current.progress.chunksInFlight).toBe(1);
    });

    act(() => {
      result.current.reset();
    });

    expect(warn).toHaveBeenCalledOnce();
    expect(result.current.progress.bytesRecorded).toBe(512);
    expect(result.current.progress.bytesUploaded).toBe(0);
    expect(result.current.progress.chunksInFlight).toBe(1);

    await act(async () => {
      upload.resolve();
      await tracked;
    });

    act(() => {
      result.current.reset();
    });

    expect(result.current.progress.bytesRecorded).toBe(0);
    expect(result.current.progress.bytesUploaded).toBe(0);
    expect(result.current.progress.chunksInFlight).toBe(0);
  });

  it("when recorded bytes are frozen, later chunks must still grow the denominator", () => {
    const { result } = renderHook(() => useUploadProgress());

    act(() => {
      result.current.onChunkRecorded(300);
      result.current.freezeRecorded();
    });

    expect(result.current.progress.bytesRecorded).toBe(300);

    act(() => {
      result.current.onChunkRecorded(75);
    });

    expect(result.current.progress.bytesRecorded).toBe(375);
  });

  it("when upload inputs describe a phase, the derived phase must match the upload truth table", () => {
    const cases: Array<{
      name: string;
      progress: UploadProgress;
      recordingStopped: boolean;
      phase: ReturnType<typeof getUploadPhase>;
    }> = [
      {
        name: "nothing recorded",
        progress: progress({}),
        recordingStopped: false,
        phase: "idle",
      },
      {
        name: "active chunk in flight",
        progress: progress({
          bytesRecorded: 200,
          bytesUploaded: 50,
          chunksInFlight: 1,
        }),
        recordingStopped: false,
        phase: "uploading",
      },
      {
        name: "recording still active after current chunks settle",
        progress: progress({
          bytesRecorded: 200,
          bytesUploaded: 200,
          chunksInFlight: 0,
        }),
        recordingStopped: false,
        phase: "uploading",
      },
      {
        name: "recording stopped and all bytes settled",
        progress: progress({
          bytesRecorded: 200,
          bytesUploaded: 200,
          chunksInFlight: 0,
        }),
        recordingStopped: true,
        phase: "done",
      },
      {
        name: "last upload error",
        progress: progress({
          bytesRecorded: 200,
          bytesUploaded: 50,
          chunksInFlight: 0,
          lastError: "network failed",
        }),
        recordingStopped: true,
        phase: "error",
      },
    ];

    for (const testCase of cases) {
      expect(
        getUploadPhase(testCase.progress, testCase.recordingStopped),
        testCase.name,
      ).toBe(testCase.phase);
    }

    expect(
      getUploadPhase(
        progress({
          bytesRecorded: 200,
          bytesUploaded: 200,
          chunksInFlight: 0,
        }),
        true,
      ),
    ).not.toBe("uploading");
  });
});
