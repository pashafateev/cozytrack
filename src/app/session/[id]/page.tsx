"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Topbar } from "@/components/ui/Topbar";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Waveform } from "@/components/ui/Waveform";
import {
  IcoChevron,
  IcoDownload,
  IcoPlay,
  IcoPause,
  IcoAlert,
} from "@/components/ui/Icon";

interface Track {
  id: string;
  participantName: string;
  s3Key: string;
  durationMs: number | null;
  format: string;
  status: string;
  createdAt: string;
  deviceLabel: string | null;
  isBuiltInMic: boolean;
}

interface Session {
  id: string;
  name: string;
  createdAt: string;
  tracks: Track[];
}

function formatDuration(ms: number | null): string {
  if (!ms) return "--:--";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60).toString().padStart(2, "0");
  const s = (totalSec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Stable numeric seed per track id so waveforms don't jitter between renders. */
function seedFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 1000;
}

export default function SessionDetailPage() {
  const params = useParams();
  const sessionId = params.id as string;
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  // Local-only scratchpad. Persistence is tracked in cozytrack#22.
  const [notes, setNotes] = useState("");
  const [notesFocused, setNotesFocused] = useState(false);

  const [playing, setPlaying] = useState<string | null>(null);

  useEffect(() => {
    async function fetchSession() {
      try {
        const res = await fetch(`/api/sessions/${sessionId}`);
        if (res.ok) {
          const data = await res.json();
          setSession(data);
        }
      } catch (error) {
        console.error("Failed to fetch session:", error);
      } finally {
        setLoading(false);
      }
    }

    fetchSession();
  }, [sessionId]);

  const longestMs = useMemo(() => {
    if (!session) return 0;
    return session.tracks.reduce<number>(
      (acc, t) => Math.max(acc, t.durationMs ?? 0),
      0,
    );
  }, [session]);

  async function handleDownload(trackId: string, participantName: string) {
    try {
      const res = await fetch(`/api/tracks/${trackId}/download`);
      if (!res.ok) throw new Error("Failed to get download URL");
      const data = await res.json();
      const link = document.createElement("a");
      link.href = data.url;
      link.download = `${participantName}.webm`;
      link.click();
    } catch (error) {
      console.error("Failed to download track:", error);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-bg">
        <Topbar />
        <div className="flex items-center justify-center text-text-3 text-sm py-24">
          Loading session…
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-screen bg-bg">
        <Topbar />
        <div className="flex flex-col items-center justify-center py-24 gap-4">
          <p className="text-text-2 text-sm">Session not found</p>
          <Link href="/dashboard" className="text-amber text-sm hover:underline">
            Back to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-page-enter min-h-screen bg-bg">
      <Topbar session={session.name} />

      <div className="max-w-[680px] mx-auto px-5 pt-8 pb-12">
        {/* Breadcrumb */}
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 text-xs text-text-3 hover:text-text-2 mb-5"
        >
          <IcoChevron size={13} color="currentColor" />
          Recordings
        </Link>

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-xl font-bold text-text tracking-[-0.02em] mb-2">
            {session.name}
          </h1>
          <div className="flex gap-4 flex-wrap">
            <span className="font-mono text-[11px] text-text-3">
              {formatDate(session.createdAt)}
            </span>
            <span className="font-mono text-[11px] text-text-3">
              {longestMs > 0 ? formatDuration(longestMs) : "--:--"}
            </span>
            <span className="font-mono text-[11px] text-text-3">
              {session.tracks.length} track{session.tracks.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>

        <div className="flex gap-2 mb-7">
          <ButtonLink href={`/studio/${session.id}`} variant="ghost" size="md">
            Open Studio
          </ButtonLink>
          <InviteButton sessionId={session.id} />
        </div>

        {/* Notes (local-only for now) */}
        <div className="mb-7">
          <label className="block font-sans text-[11px] font-medium text-text-3 uppercase tracking-[0.08em] mb-2">
            Session Notes
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onFocus={() => setNotesFocused(true)}
            onBlur={() => setNotesFocused(false)}
            rows={3}
            placeholder="Notes are local-only for now and will clear on refresh."
            className="w-full px-3.5 py-2.5 text-[13px] leading-[1.6] font-sans text-text-2 bg-card rounded-md resize-y outline-none border"
            style={{
              borderColor: notesFocused ? "var(--border-hi)" : "var(--border)",
            }}
          />
          <p className="mt-1.5 flex items-center gap-1.5 text-[10px] font-mono text-text-3">
            <IcoAlert size={10} color="currentColor" />
            Local-only for now. Persistence tracked in #22.
          </p>
        </div>

        {/* Tracks */}
        <div className="mb-6">
          <label className="block font-sans text-[11px] font-medium text-text-3 uppercase tracking-[0.08em] mb-2.5">
            Tracks
          </label>

          {session.tracks.length === 0 ? (
            <div className="text-center py-10 rounded-lg bg-card border border-[color:var(--border)]">
              <p className="text-text-2 text-sm">No tracks recorded yet</p>
              <p className="text-text-3 text-xs mt-1.5">
                Open the studio to start recording.
              </p>
            </div>
          ) : (
            <div
              className="flex flex-col gap-px rounded-lg overflow-hidden"
              style={{ background: "var(--border)" }}
            >
              {session.tracks.map((t) => {
                const isPlaying = playing === t.id;
                return (
                  <div
                    key={t.id}
                    className="flex items-center gap-3.5 py-3.5 px-4"
                    style={{ background: "var(--card)" }}
                  >
                    {/* Avatar */}
                    <div
                      className="w-[30px] h-[30px] rounded-full flex items-center justify-center flex-shrink-0 border"
                      style={{
                        background: "var(--card-hi)",
                        borderColor: "var(--border-hi)",
                      }}
                    >
                      <span className="text-[11px] font-semibold text-text-2">
                        {t.participantName.charAt(0).toUpperCase()}
                      </span>
                    </div>

                    {/* Name + peak */}
                    <div className="w-[90px] flex-shrink-0 min-w-0">
                      <div className="text-[13px] font-semibold text-text truncate flex items-center gap-1">
                        <span className="truncate">{t.participantName}</span>
                        {t.isBuiltInMic && (
                          <span
                            title="Recorded with built-in mic"
                            aria-label="Recorded with built-in mic"
                          >
                            <IcoAlert size={11} color="var(--warn)" />
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-[10px] text-text-3 mt-0.5">
                        {formatDuration(t.durationMs)}
                      </div>
                    </div>

                    {/* Play button is a placeholder until #24 wires real audio. */}
                    <button
                      type="button"
                      disabled={t.status !== "complete"}
                      onClick={() => setPlaying(isPlaying ? null : t.id)}
                      title={
                        t.status === "complete"
                          ? "In-browser playback coming soon"
                          : `Track is ${t.status}`
                      }
                      className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 border disabled:opacity-30 disabled:cursor-not-allowed"
                      style={{
                        borderColor: "var(--border-hi)",
                        background: isPlaying ? "var(--card-hi)" : "transparent",
                      }}
                    >
                      {isPlaying ? (
                        <IcoPause size={11} color="var(--text-2)" />
                      ) : (
                        <IcoPlay size={11} color="var(--text-2)" />
                      )}
                    </button>

                    {/* Decorative placeholder waveform. Real extraction tracked in #24. */}
                    <div className="flex-1 min-w-0">
                      <Waveform height={26} seed={seedFromId(t.id)} played={isPlaying ? 0.1 : 0} />
                    </div>

                    {/* Status + download */}
                    <div className="flex items-center gap-2.5 flex-shrink-0">
                      <span className="font-mono text-[10px] text-text-3 uppercase">
                        {t.status}
                      </span>
                      {t.status === "complete" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDownload(t.id, t.participantName)}
                          title="Download this track"
                        >
                          <IcoDownload size={12} color="currentColor" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Download all — blocked on cozytrack#26 (zip-all endpoint) */}
        <div className="flex justify-end">
          <Button
            variant="primary"
            size="md"
            disabled
            title="Bulk zip download tracked in #26 — download individual tracks for now"
          >
            <IcoDownload size={13} color="currentColor" /> Download All Tracks
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Host-only button that mints an invite link and copies it to the clipboard.
 * Rendered on the session detail page. Middleware gates /session/<id> to
 * host auth only (guests never reach this page), so the button can assume
 * the caller is a host. The underlying API endpoint also enforces this.
 */
function InviteButton({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "pending" }
    | { kind: "ready"; url: string; expiresInSeconds: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function onClick() {
    setState({ kind: "pending" });
    try {
      const res = await fetch(`/api/sessions/${sessionId}/invite`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setState({ kind: "error", message: body.error ?? "Failed to create invite" });
        return;
      }
      const { url, expiresInSeconds } = await res.json();
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        // Clipboard may fail in insecure contexts — the URL is still shown.
      }
      setState({ kind: "ready", url, expiresInSeconds });
    } catch {
      setState({ kind: "error", message: "Network error" });
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="ghost"
        size="md"
        onClick={onClick}
        disabled={state.kind === "pending"}
        title="Generate an invite link for a cohost. The link works until it expires; anyone with it can join until then."
      >
        {state.kind === "pending" ? "Generating…" : "Invite cohost"}
      </Button>
      {state.kind === "ready" && (
        <div className="text-[11px] font-mono text-text-3 break-all max-w-[520px]">
          <div className="text-text-2 mb-1">
            Copied to clipboard — this invite link expires in {Math.round(state.expiresInSeconds / 3600)}h
          </div>
          {state.url}
        </div>
      )}
      {state.kind === "error" && (
        <div className="text-[11px] text-red-400">{state.message}</div>
      )}
    </div>
  );
}

