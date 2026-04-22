"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

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
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

export default function SessionDetailPage() {
  const params = useParams();
  const sessionId = params.id as string;
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

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
      <div className="min-h-screen flex items-center justify-center text-gray-400">
        Loading session...
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-400 text-lg">Session not found</p>
          <Link
            href="/dashboard"
            className="text-indigo-400 hover:text-indigo-300 mt-4 inline-block"
          >
            Back to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 py-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <Link
            href="/dashboard"
            className="text-gray-400 hover:text-white transition-colors text-sm"
          >
            &larr; Back to Dashboard
          </Link>
          <h1 className="text-3xl font-bold text-white mt-4">{session.name}</h1>
          <p className="text-gray-400 mt-1">
            {new Date(session.createdAt).toLocaleDateString()} &middot;{" "}
            {session.tracks.length}{" "}
            {session.tracks.length === 1 ? "track" : "tracks"}
          </p>
        </div>

        <div className="flex gap-3 mb-8">
          <Link
            href={`/studio/${session.id}`}
            className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-medium transition-colors text-sm"
          >
            Open Studio
          </Link>
        </div>

        {session.tracks.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-400">No tracks recorded yet</p>
            <p className="text-gray-500 mt-2 text-sm">
              Open the studio to start recording.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {session.tracks.map((track) => (
              <div
                key={track.id}
                className="p-4 rounded-lg bg-cozy-900 border border-cozy-700"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-cozy-700 flex items-center justify-center text-sm font-medium text-white">
                      {track.participantName.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-white">
                          {track.participantName}
                        </p>
                        {track.isBuiltInMic && (
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-yellow-900/40 text-yellow-400 border border-yellow-800"
                          >
                            ⚠ Built-in mic
                            <span className="sr-only">
                              {` Recorded with built-in mic${track.deviceLabel ? `: ${track.deviceLabel}` : ""}`}
                            </span>
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-sm text-gray-400">
                        <span>{formatDuration(track.durationMs)}</span>
                        <span>{track.format.toUpperCase()}</span>
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs ${
                            track.status === "complete"
                              ? "bg-green-900/50 text-green-400"
                              : track.status === "recording"
                                ? "bg-red-900/50 text-red-400"
                                : track.status === "failed"
                                  ? "bg-red-900/50 text-red-400"
                                  : "bg-yellow-900/50 text-yellow-400"
                          }`}
                        >
                          {track.status}
                        </span>
                      </div>
                    </div>
                  </div>

                  {track.status === "complete" && (
                    <button
                      onClick={() =>
                        handleDownload(track.id, track.participantName)
                      }
                      className="px-4 py-2 rounded-lg bg-cozy-700 hover:bg-cozy-600 text-white text-sm font-medium transition-colors"
                    >
                      Download
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
