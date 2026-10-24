"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

export function PodlineIngestCommand({ sessionId }: { sessionId: string }) {
  const command = `pod ct-ingest ${sessionId}`;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  async function copyCommand() {
    setCopyState("idle");
    try {
      await navigator.clipboard.writeText(command);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  return (
    <div className="w-full space-y-3 text-left">
      <h2 className="text-sm font-semibold text-text">Import into Podline</h2>
      <p className="text-xs text-text-3">
        Run in your terminal to download this session&apos;s tracks, upload them
        to Podline&apos;s storage, and register the session for processing.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <textarea
          aria-label="Podline ingest command"
          readOnly
          rows={2}
          spellCheck={false}
          value={command}
          onFocus={(event) => event.currentTarget.select()}
          className="min-w-0 flex-1 resize-none rounded-[8px] border border-[color:var(--border)] bg-bg px-3 py-2 font-mono text-xs text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
        />
        <Button type="button" onClick={copyCommand} className="shrink-0" aria-live="polite">
          {copyState === "copied" ? "Copied" : "Copy command"}
        </Button>
      </div>
      {copyState === "error" && (
        <p role="status" className="text-xs text-warn">
          Couldn&apos;t copy automatically. Select and copy the command above.
        </p>
      )}
    </div>
  );
}
