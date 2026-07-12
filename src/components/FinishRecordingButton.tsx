"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { stopRecordingTake } from "@/lib/recording-state";

interface ActiveTake {
  id: string;
  startedAt: string;
}

type FinishState =
  | { kind: "idle" }
  | { kind: "polling"; pendingName?: string }
  | { kind: "active_take"; activeTake: ActiveTake; message: string }
  | { kind: "ready" }
  | { kind: "timeout"; pendingName?: string }
  | { kind: "error"; message: string };

interface PendingTrack {
  trackId: string;
  participantName: string;
  status: string;
}

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30_000;

export function FinishRecordingButton({
  sessionId,
  waitForUploads,
  onReady,
  departedParticipantNames,
}: {
  sessionId: string;
  waitForUploads: () => Promise<void>;
  onReady?: () => void;
  /**
   * Display names of participants who left the studio while this page was
   * open. Best-effort, client-side knowledge: it exists so a finalize blocked
   * on a departed participant's track says "Bob left" instead of implying the
   * upload is still progressing. Lost on refresh; superseded once the server
   * tracks abandoned takes itself (#154).
   */
  departedParticipantNames?: string[];
}) {
  const [state, setState] = useState<FinishState>({ kind: "idle" });
  const [copied, setCopied] = useState(false);

  const isMountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const safeSetState = useCallback((next: FinishState) => {
    if (isMountedRef.current) {
      setState(next);
    }
  }, []);

  const runFinalize = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    safeSetState({ kind: "polling" });

    try {
      await waitForUploads();
    } catch (err) {
      console.error("Failed waiting for uploads to drain:", err);
    }

    if (controller.signal.aborted || !isMountedRef.current) return;

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    // Carried into the timeout state so it can name who the poll was stuck on.
    let lastPendingName: string | undefined;

    while (Date.now() <= deadline) {
      if (controller.signal.aborted || !isMountedRef.current) return;

      let res: Response;
      try {
        res = await fetch(`/api/sessions/${sessionId}/finalize`, {
          method: "POST",
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted || !isMountedRef.current) return;
        console.error("Finalize request failed:", err);
        await sleep(POLL_INTERVAL_MS, controller.signal);
        continue;
      }

      if (controller.signal.aborted || !isMountedRef.current) return;

      if (res.ok) {
        safeSetState({ kind: "ready" });
        onReady?.();
        return;
      }

      if (res.status === 409) {
        let pendingName: string | undefined;
        let activeTake: ActiveTake | undefined;
        let error: string | undefined;
        try {
          const data = (await res.json()) as {
            pending?: PendingTrack[];
            activeTake?: ActiveTake;
            error?: string;
          };
          pendingName = data.pending?.[0]?.participantName;
          activeTake = data.activeTake;
          error = data.error;
        } catch {
          // ignore parse errors
        }
        if (controller.signal.aborted || !isMountedRef.current) return;
        if (activeTake) {
          safeSetState({
            kind: "active_take",
            activeTake,
            message: error ?? "An unfinished recording take is still active.",
          });
          return;
        }
        lastPendingName = pendingName ?? lastPendingName;
        safeSetState({ kind: "polling", pendingName });
        await sleep(POLL_INTERVAL_MS, controller.signal);
        continue;
      }

      const message = `Finalize failed (HTTP ${res.status})`;
      safeSetState({ kind: "error", message });
      return;
    }

    safeSetState({ kind: "timeout", pendingName: lastPendingName });
  }, [sessionId, waitForUploads, onReady, safeSetState]);

  const recoverActiveTake = useCallback(async () => {
    if (state.kind !== "active_take") return;

    const confirmed = window.confirm(
      "End this unfinished recording take and continue finalizing?",
    );
    if (!confirmed) return;

    safeSetState({ kind: "polling" });
    try {
      await stopRecordingTake(sessionId, { takeId: state.activeTake.id });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to end unfinished take";
      safeSetState({ kind: "error", message });
      return;
    }

    if (!isMountedRef.current) return;
    await runFinalize();
  }, [runFinalize, safeSetState, sessionId, state]);

  const copyId = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(sessionId);
      if (!isMountedRef.current) return;
      setCopied(true);
      setTimeout(() => {
        if (isMountedRef.current) setCopied(false);
      }, 1500);
    } catch (err) {
      console.error("Clipboard copy failed:", err);
    }
  }, [sessionId]);

  if (state.kind === "ready") {
    return (
      <div className="flex flex-col items-center gap-3 p-6 rounded-xl bg-cozy-900 border border-green-700">
        <p className="text-green-400 font-medium">Ready for ingest</p>
        <div className="flex items-center gap-2">
          <code className="px-3 py-1.5 rounded bg-cozy-800 text-white font-mono text-sm select-all">
            {sessionId}
          </code>
          <button
            onClick={copyId}
            className="px-3 py-1.5 rounded bg-cozy-700 hover:bg-cozy-600 text-white text-xs"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="text-gray-400 text-xs">
          Run on your laptop:{" "}
          <code className="text-gray-200">sd ct-ingest {sessionId}</code>
        </p>
      </div>
    );
  }

  if (state.kind === "timeout") {
    const departed =
      state.pendingName !== undefined &&
      departedParticipantNames?.includes(state.pendingName);
    return (
      <div className="flex flex-col items-center gap-3 p-4 rounded-xl bg-cozy-900 border border-yellow-700">
        <p className="text-yellow-400 text-sm text-center">
          {departed
            ? `${state.pendingName} left before their track finished uploading — retry to recover what they already uploaded.`
            : "Some tracks haven't uploaded yet — check your network and retry."}
        </p>
        <button
          onClick={runFinalize}
          className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium"
        >
          Retry
        </button>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="flex flex-col items-center gap-3 p-4 rounded-xl bg-cozy-900 border border-red-700">
        <p className="text-red-400 text-sm">{state.message}</p>
        <button
          onClick={runFinalize}
          className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium"
        >
          Retry
        </button>
      </div>
    );
  }

  if (state.kind === "active_take") {
    return (
      <div className="flex flex-col items-center gap-3 p-4 rounded-xl bg-cozy-900 border border-yellow-700">
        <p className="text-yellow-400 text-sm text-center">{state.message}</p>
        <p className="text-gray-400 text-xs">
          Started {new Date(state.activeTake.startedAt).toLocaleString()}
        </p>
        <button
          onClick={recoverActiveTake}
          className="px-4 py-2 rounded-lg bg-yellow-600 hover:bg-yellow-700 text-white text-sm font-medium"
        >
          End unfinished take and continue
        </button>
      </div>
    );
  }

  if (state.kind === "polling") {
    const departed =
      state.pendingName !== undefined &&
      departedParticipantNames?.includes(state.pendingName);
    const label = departed
      ? `${state.pendingName} left the session — recovering their uploaded audio…`
      : state.pendingName
        ? `Still uploading track: ${state.pendingName}…`
        : "Finalizing…";
    return (
      <div className="flex flex-col items-center gap-2 p-4 rounded-xl bg-cozy-900 border border-cozy-700">
        <p className="text-gray-300 text-sm animate-pulse">{label}</p>
      </div>
    );
  }

  return (
    <button
      onClick={runFinalize}
      className="px-6 py-3 rounded-lg bg-green-600 hover:bg-green-700 text-white font-medium transition-colors"
    >
      Finish recording
    </button>
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
