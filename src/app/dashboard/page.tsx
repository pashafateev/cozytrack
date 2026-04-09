"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Track {
  id: string;
  participantName: string;
  status: string;
}

interface Session {
  id: string;
  name: string;
  createdAt: string;
  tracks: Track[];
}

export default function DashboardPage() {
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

  return (
    <div className="min-h-screen px-4 py-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold text-white">Dashboard</h1>
          <Link
            href="/"
            className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-medium transition-colors"
          >
            New Session
          </Link>
        </div>

        {loading ? (
          <div className="text-gray-400 text-center py-12">Loading sessions...</div>
        ) : sessions.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-400 text-lg">No sessions yet</p>
            <p className="text-gray-500 mt-2">
              Create your first recording session to get started.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {sessions.map((session) => (
              <Link
                key={session.id}
                href={`/session/${session.id}`}
                className="block p-4 rounded-lg bg-cozy-900 border border-cozy-700 hover:border-cozy-500 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-medium text-white">
                      {session.name}
                    </h2>
                    <p className="text-sm text-gray-400 mt-1">
                      {new Date(session.createdAt).toLocaleDateString()} &middot;{" "}
                      {session.tracks.length}{" "}
                      {session.tracks.length === 1 ? "track" : "tracks"}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {session.tracks.map((track) => (
                      <span
                        key={track.id}
                        className={`px-2 py-1 text-xs rounded-full ${
                          track.status === "complete"
                            ? "bg-green-900/50 text-green-400"
                            : track.status === "recording"
                              ? "bg-red-900/50 text-red-400"
                              : "bg-yellow-900/50 text-yellow-400"
                        }`}
                      >
                        {track.participantName}
                      </span>
                    ))}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
