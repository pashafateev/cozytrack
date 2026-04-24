"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { IcoMic } from "@/components/ui/Icon";

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
      {/* Ambient amber glow behind the wordmark — sets the mood on first load */}
      <div
        aria-hidden
        className="absolute pointer-events-none"
        style={{
          top: "38%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 500,
          height: 500,
          background:
            "radial-gradient(ellipse, rgba(200,120,64,0.18) 0%, transparent 65%)",
        }}
      />
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 pointer-events-none"
        style={{
          height: 200,
          background:
            "linear-gradient(to top, rgba(13,11,8,0.8), transparent)",
        }}
      />

      <div className="relative z-10 flex flex-col items-center w-[340px]">
        <div className="mb-7 opacity-40">
          <IcoMic size={36} color="var(--text)" />
        </div>

        <h1 className="text-[28px] font-bold tracking-[-0.04em] mb-2 text-text">
          cozy<span style={{ color: "var(--amber)" }}>track</span>
        </h1>
        <p className="text-[13px] text-text-3 mb-9">a home for your recordings</p>

        <div className="w-full mb-2.5">
          <input
            type="text"
            placeholder="Name this session…"
            value={sessionName}
            onChange={(e) => setSessionName(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => e.key === "Enter" && canSubmit && handleCreateSession()}
            className="w-full px-3.5 py-[11px] text-sm font-sans bg-card text-text rounded-md outline-none border transition-[border-color] duration-150"
            style={{
              borderColor: focused ? "var(--border-hi)" : "var(--border)",
            }}
          />
        </div>

        <button
          onClick={handleCreateSession}
          disabled={!canSubmit}
          className="w-full py-[11px] text-[15px] font-semibold font-sans rounded-md border transition-all duration-200"
          style={{
            background: canSubmit ? "var(--amber)" : "var(--card)",
            color: canSubmit ? "var(--bg)" : "var(--text-3)",
            borderColor: canSubmit ? "var(--amber)" : "var(--border)",
            cursor: canSubmit ? "pointer" : "default",
          }}
        >
          {creating ? "Creating…" : "Record →"}
        </button>

        <Link
          href="/dashboard"
          className="mt-[18px] text-[12px] text-text-3 underline underline-offset-2 hover:text-text-2"
          style={{ textDecorationColor: "rgba(87,79,68,0.6)" }}
        >
          past sessions
        </Link>
      </div>
    </div>
  );
}
