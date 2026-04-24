"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Topbar } from "@/components/ui/Topbar";
import { Button } from "@/components/ui/Button";
import { Waveform } from "@/components/ui/Waveform";
import { IcoDownload, IcoPlus } from "@/components/ui/Icon";

interface Track {
  id: string;
  participantName: string;
  status: string;
  durationMs: number | null;
}

interface Session {
  id: string;
  name: string;
  createdAt: string;
  tracks: Track[];
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDuration(ms: number | null): string {
  if (!ms) return "--:--";
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60).toString().padStart(2, "0");
  const s = (total % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

/** Pull a stable numeric seed out of a session id so waveforms stay consistent. */
function seedFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return h % 1000;
}

/** Rough aggregate duration across all tracks. Max of tracks, not sum — tracks
 *  are recorded in parallel, so the longest track is a good proxy for session
 *  length. Accurate per-session duration + total size is tracked in #29. */
function sessionDuration(s: Session): string {
  const longest = s.tracks.reduce<number>((acc, t) => Math.max(acc, t.durationMs ?? 0), 0);
  return longest > 0 ? formatDuration(longest) : "--:--";
}

export default function DashboardPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchSessions() {
      try {
        const res = await fetch("/api/sessions");
        if (res.ok) {
          const data = await res.json();
          setSessions(data);
        }
      } catch (error) {
        console.error("Failed to fetch sessions:", error);
      } finally {
        setLoading(false);
      }
    }

    fetchSessions();
  }, []);

  const trackCount = useMemo(
    () => sessions.reduce((acc, s) => acc + s.tracks.length, 0),
    [sessions],
  );

  return (
    <div className="animate-page-enter min-h-screen bg-bg">
      <Topbar />
      <div className="max-w-[740px] mx-auto px-5 pt-8 pb-12">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-text tracking-[-0.02em]">Recordings</h1>
            <p className="text-xs text-text-3 mt-0.5">
              {sessions.length} session{sessions.length === 1 ? "" : "s"} · {trackCount} track
              {trackCount === 1 ? "" : "s"} total
            </p>
          </div>
          <Button variant="primary" size="md" onClick={() => router.push("/")}>
            <IcoPlus size={13} color="currentColor" /> New Session
          </Button>
        </div>

        {loading ? (
          <div className="text-text-3 text-center py-16 text-sm">Loading sessions…</div>
        ) : sessions.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-text-2 text-sm">No sessions yet</p>
            <p className="text-text-3 mt-1.5 text-xs">
              Create your first recording session to get started.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {sessions.map((s) => (
              <Link
                key={s.id}
                href={`/session/${s.id}`}
                className="group block rounded-lg p-4 border transition-[border-color,background-color] duration-150"
                style={{
                  background: "var(--card)",
                  borderColor: "var(--border)",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--border-hi)";
                  e.currentTarget.style.background = "var(--card-hi)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "var(--border)";
                  e.currentTarget.style.background = "var(--card)";
                }}
              >
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="text-sm font-semibold text-text mb-1">{s.name}</div>
                    <div className="flex gap-3 flex-wrap">
                      <span className="font-mono text-[11px] text-text-3">{formatDate(s.createdAt)}</span>
                      <span className="font-mono text-[11px] text-text-3">{sessionDuration(s)}</span>
                      <span className="font-mono text-[11px] text-text-3">
                        {s.tracks.length} track{s.tracks.length === 1 ? "" : "s"}
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-1.5 flex-shrink-0">
                    <Button variant="ghost" size="sm">View</Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        // Bulk zip download is tracked in #26. Keep the button inert for now
                        // but still capture the click so card navigation doesn't fire.
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      title="Bulk zip download tracked in #26"
                    >
                      <IcoDownload size={12} color="currentColor" /> Download
                    </Button>
                  </div>
                </div>
                <Waveform height={24} seed={seedFromId(s.id)} played={0} />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
