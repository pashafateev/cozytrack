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
  | { kind: "timeout" }
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
}: {
  sessionId: string;
  waitForUploads: () => Promise<void>;
  onReady?: () => void;
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
        safeSetState({ kind: "polling", pendingName });
        await sleep(POLL_INTERVAL_MS, controller.signal);
        continue;
      }

      const message = `Finalize failed (HTTP ${res.status})`;
      safeSetState({ kind: "error", message });
      return;
    }

    safeSetState({ kind: "timeout" });
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
      <div
        className="flex flex-col items-center gap-3 p-6 rounded-[10px] border"
        style={{ background: "var(--card)", borderColor: "rgba(70,214,140,0.35)" }}
      >
        <p className="text-ok font-medium">Ready for ingest</p>
        <div className="flex items-center gap-2">
          <code
            className="px-3 py-1.5 rounded-[8px] border text-text font-mono text-sm select-all"
            style={{ background: "var(--bg)", borderColor: "var(--border)" }}
          >
            {sessionId}
          </code>
          <button
            onClick={copyId}
            className="px-3 py-1.5 rounded-[8px] border text-text-2 text-xs hover:text-text"
            style={{ background: "var(--card-hi)", borderColor: "var(--border-hi)" }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="text-text-3 text-xs">
          Run on your laptop:{" "}
          <code className="text-text-2">sd ct-ingest {sessionId}</code>
        </p>
      </div>
    );
  }

  if (state.kind === "timeout") {
    return (
      <div
        className="flex flex-col items-center gap-3 p-4 rounded-[10px] border"
        style={{ background: "var(--card)", borderColor: "rgba(255,179,71,0.35)" }}
      >
        <p className="text-warn text-sm text-center">
          Some tracks haven&apos;t uploaded yet — check your network and retry.
        </p>
        <button
          onClick={runFinalize}
          className="px-4 py-2 rounded-[8px] bg-accent hover:bg-accent-hi text-accent-ink text-sm font-semibold"
        >
          Retry
        </button>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div
        className="flex flex-col items-center gap-3 p-4 rounded-[10px] border"
        style={{ background: "var(--card)", borderColor: "rgba(255,59,77,0.35)" }}
      >
        <p className="text-rec text-sm">{state.message}</p>
        <button
          onClick={runFinalize}
          className="px-4 py-2 rounded-[8px] bg-accent hover:bg-accent-hi text-accent-ink text-sm font-semibold"
        >
          Retry
        </button>
      </div>
    );
  }

  if (state.kind === "active_take") {
    return (
      <div
        className="flex flex-col items-center gap-3 p-4 rounded-[10px] border"
        style={{ background: "var(--card)", borderColor: "rgba(255,179,71,0.35)" }}
      >
        <p className="text-warn text-sm text-center">{state.message}</p>
        <p className="text-text-3 text-xs">
          Started {new Date(state.activeTake.startedAt).toLocaleString()}
        </p>
        <button
          onClick={recoverActiveTake}
          className="px-4 py-2 rounded-[8px] text-sm font-semibold border"
          style={{
            background: "rgba(255,179,71,0.14)",
            borderColor: "rgba(255,179,71,0.4)",
            color: "var(--warn)",
          }}
        >
          End unfinished take and continue
        </button>
      </div>
    );
  }

  if (state.kind === "polling") {
    const label = state.pendingName
      ? `Still uploading track: ${state.pendingName}…`
      : "Finalizing…";
    return (
      <div
        className="flex flex-col items-center gap-2 p-4 rounded-[10px] border"
        style={{ background: "var(--card)", borderColor: "var(--border-hi)" }}
      >
        <p className="text-text-2 text-sm animate-pulse">{label}</p>
      </div>
    );
  }

  return (
    <button
      onClick={runFinalize}
      className="px-4 py-[9px] rounded-full text-[12.5px] font-semibold text-accent-ink transition-opacity hover:opacity-90"
      style={{
        background: "linear-gradient(100deg,#ff4d7d,#ff7a54)",
        boxShadow: "0 2px 18px rgba(255,77,125,0.35)",
      }}
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
