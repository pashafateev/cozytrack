"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { Aurora } from "@/components/ui/Aurora";
import { Wordmark } from "@/components/ui/Wordmark";
import { LavaLamp } from "@/components/LavaLamp";

export default function HomePage() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [sessionName, setSessionName] = useState("");
  const [focused, setFocused] = useState(false);

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

  // Name is optional — handleCreateSession() falls back to a dated default
  // when the user leaves the field blank. We only block the submit while a
  // create request is already in flight.
  const canSubmit = !creating;

  return (
    <div className="animate-page-enter min-h-screen flex flex-col items-center justify-center relative overflow-hidden bg-bg">
      <Aurora variant="home" />

      <div className="relative z-10 flex flex-col items-center w-[340px] text-center">
        {/* Idle lamp as the brand mark — the room is quiet until you record. */}
        <div className="relative mb-2" style={{ height: 130, aspectRatio: "400 / 640" }}>
          <LavaLamp idle seed={21} />
        </div>

        <Wordmark size={28} href={null} className="tracking-[-0.04em]" />
        <p className="text-[13px] text-text-3 mt-1.5">a home for your recordings</p>

        <div className="w-full mt-[26px] mb-3">
          <input
            type="text"
            placeholder="Name this session…"
            value={sessionName}
            onChange={(e) => setSessionName(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => e.key === "Enter" && canSubmit && handleCreateSession()}
            className="w-full px-3.5 py-[11px] text-sm text-left font-sans bg-card text-text placeholder:text-text-3 rounded-[8px] outline-none border transition-[border-color] duration-150"
            style={{
              borderColor: focused ? "var(--border-hi)" : "var(--border)",
            }}
          />
        </div>

        {/* Record affordance — the reserved Sunset gradient lives here. */}
        <button
          onClick={handleCreateSession}
          disabled={!canSubmit}
          className="w-full py-[11px] text-[15px] font-semibold font-sans rounded-[10px] transition-all duration-200"
          style={{
            background: canSubmit
              ? "linear-gradient(100deg,#ff4d7d,#ff7a54)"
              : "var(--card)",
            color: canSubmit ? "#2b0b18" : "var(--text-3)",
            boxShadow: canSubmit ? "0 2px 18px rgba(255,77,125,0.35)" : undefined,
            cursor: canSubmit ? "pointer" : "default",
          }}
        >
          {creating ? "Creating…" : "Record →"}
        </button>

        <Link
          href="/dashboard"
          className="mt-5 text-[12px] text-text-2 underline underline-offset-2 hover:text-text"
          style={{ textDecorationColor: "rgba(154,144,194,0.6)" }}
        >
          past sessions
        </Link>
      </div>
    </div>
  );
}
