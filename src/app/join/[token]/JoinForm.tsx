"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function JoinForm({
  token,
  sessionName,
  sessionId,
}: {
  token: string;
  sessionName: string;
  sessionId: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/accept-invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, name: name.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Could not join session");
        setPending(false);
        return;
      }
      router.push(`/studio/${sessionId}`);
      router.refresh();
    } catch {
      setError("Network error");
      setPending(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-100 px-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
        <div className="space-y-1">
          <p className="text-sm text-neutral-400">You&apos;re invited to record</p>
          <h1 className="text-2xl font-semibold">{sessionName}</h1>
        </div>
        <div className="space-y-2">
          <label htmlFor="name" className="block text-sm text-neutral-300">
            Your name
          </label>
          <input
            id="name"
            name="name"
            type="text"
            autoFocus
            required
            minLength={1}
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-600"
          />
        </div>
        {error && (
          <p className="text-sm text-red-400" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={pending || name.trim().length === 0}
          className="w-full rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {pending ? "Joining…" : "Join session"}
        </button>
      </form>
    </div>
  );
}
