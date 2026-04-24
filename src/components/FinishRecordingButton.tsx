"use client";

import { useCallback, useState } from "react";

type FinishState =
  | { kind: "idle" }
  | { kind: "polling"; pendingName?: string }
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

  const runFinalize = useCallback(async () => {
    setState({ kind: "polling" });

    try {
      await waitForUploads();
    } catch (err) {
      console.error("Failed waiting for uploads to drain:", err);
    }

    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() <= deadline) {
      let res: Response;
      try {
        res = await fetch(`/api/sessions/${sessionId}/finalize`, {
          method: "POST",
        });
      } catch (err) {
        console.error("Finalize request failed:", err);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      if (res.ok) {
        setState({ kind: "ready" });
        onReady?.();
        return;
      }

      if (res.status === 409) {
        let pendingName: string | undefined;
        try {
          const data = (await res.json()) as { pending?: PendingTrack[] };
          pendingName = data.pending?.[0]?.participantName;
        } catch {
          // ignore parse errors
        }
        setState({ kind: "polling", pendingName });
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const message = `Finalize failed (HTTP ${res.status})`;
      setState({ kind: "error", message });
      return;
    }

    setState({ kind: "timeout" });
  }, [sessionId, waitForUploads, onReady]);

  const copyId = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(sessionId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
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
    return (
      <div className="flex flex-col items-center gap-3 p-4 rounded-xl bg-cozy-900 border border-yellow-700">
        <p className="text-yellow-400 text-sm text-center">
          Some tracks haven&apos;t uploaded yet — check your network and retry.
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

  if (state.kind === "polling") {
    const label = state.pendingName
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
