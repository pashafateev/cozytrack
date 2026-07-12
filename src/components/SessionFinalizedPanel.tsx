"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

/**
 * Shown when the studio's session is finalized (status "ready"). A finalized
 * session rejects every new take server-side (issue #151), so without this
 * panel the studio is a dead end: the REC button can only 409 and the toast's
 * "Start a new session" advice has no button to click. Hosts get a one-click
 * create-and-go; guests are told to ask the host (only hosts can create
 * sessions).
 */
export function SessionFinalizedPanel({ isHost }: { isHost: boolean }) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStartNewSession() {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `Session ${new Date().toLocaleDateString()}`,
        }),
      });
      if (!res.ok) throw new Error(`Failed to create session (HTTP ${res.status})`);
      const session: { id: string } = await res.json();
      // Full document navigation on purpose: pushing /studio/[newId] via the
      // app router reuses this page instance (Next keeps dynamic-route pages
      // mounted across param changes), which would carry the old LiveKit
      // room, device streams, and recording state into the new session. A
      // fresh load guarantees a clean studio.
      window.location.assign(`/studio/${session.id}`);
    } catch (err) {
      console.error("Failed to create session:", err);
      setError("Couldn't create a new session — try again.");
      setCreating(false);
    }
  }

  return (
    <div
      className="flex flex-col items-center gap-2.5 px-5 py-4 rounded-lg border text-center max-w-[360px]"
      style={{ background: "var(--card)", borderColor: "var(--border)" }}
    >
      <p className="text-[13px] font-semibold text-text">Session finalized</p>
      <p className="text-[12px] text-text-3 leading-relaxed">
        This session can no longer be recorded into.
        {isHost
          ? " Start a new session to keep recording."
          : " Ask the host to start a new session."}
      </p>
      {isHost && (
        <Button
          variant="primary"
          size="md"
          onClick={handleStartNewSession}
          disabled={creating}
        >
          {creating ? "Creating…" : "Start a new session"}
        </Button>
      )}
      {error && (
        <p className="text-[12px]" style={{ color: "var(--rec)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
