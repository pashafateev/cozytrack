"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Aurora } from "@/components/ui/Aurora";

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
  const [focused, setFocused] = useState(false);

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
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden bg-bg px-4">
      <Aurora variant="auth" />
      <form onSubmit={onSubmit} className="relative w-full max-w-[360px] flex flex-col">
        <p className="text-[13px] text-text-2">You&apos;re invited to record</p>
        <h1 className="text-[26px] font-extrabold tracking-[-0.02em] text-text mt-1">
          {sessionName}
        </h1>
        <input
          id="name"
          name="name"
          type="text"
          aria-label="Your name"
          placeholder="Your name"
          autoFocus
          required
          minLength={1}
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className="w-full mt-7 px-3.5 py-2.5 text-sm font-sans bg-card text-text placeholder:text-text-3 rounded-[8px] outline-none border transition-[border-color] duration-150"
          style={{ borderColor: focused ? "var(--border-hi)" : "var(--border)" }}
        />
        {error && (
          <p className="text-sm text-rec mt-3" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={pending || name.trim().length === 0}
          className="w-full mt-4 py-[11px] text-[15px] font-semibold font-sans rounded-[10px] bg-accent text-accent-ink hover:bg-accent-hi disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {pending ? "Joining…" : "Join session"}
        </button>
      </form>
    </div>
  );
}
