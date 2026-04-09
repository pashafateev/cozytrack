"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";

export default function HomePage() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [sessionName, setSessionName] = useState("");

  async function handleCreateSession() {
    const name = sessionName.trim() || `Session ${new Date().toLocaleDateString()}`;
    setCreating(true);

    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      if (!res.ok) throw new Error("Failed to create session");

      const session = await res.json();
      router.push(`/studio/${session.id}`);
    } catch (error) {
      console.error("Failed to create session:", error);
      setCreating(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4">
      <div className="max-w-md w-full space-y-8 text-center">
        <div>
          <h1 className="text-5xl font-bold tracking-tight text-white">
            Cozytrack
          </h1>
          <p className="mt-3 text-lg text-gray-400">
            Self-hosted podcast recording studio. Local-first audio,
            crystal-clear quality.
          </p>
        </div>

        <div className="space-y-4">
          <input
            type="text"
            placeholder="Session name (optional)"
            value={sessionName}
            onChange={(e) => setSessionName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreateSession()}
            className="w-full px-4 py-3 rounded-lg bg-cozy-900 border border-cozy-700 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />

          <button
            onClick={handleCreateSession}
            disabled={creating}
            className="w-full px-6 py-3 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {creating ? "Creating..." : "Create New Session"}
          </button>
        </div>

        <Link
          href="/dashboard"
          className="inline-block text-gray-400 hover:text-white transition-colors"
        >
          View Dashboard
        </Link>
      </div>
    </div>
  );
}
