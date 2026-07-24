"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Aurora } from "@/components/ui/Aurora";
import { Wordmark } from "@/components/ui/Wordmark";

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const returnTo = params.get("return_to") ?? "/dashboard";

  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [focused, setFocused] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/signin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Sign-in failed");
        setPending(false);
        return;
      }
      // Avoid open-redirect: only allow same-origin return_to
      const safeReturnTo = returnTo.startsWith("/") && !returnTo.startsWith("//")
        ? returnTo
        : "/dashboard";
      router.push(safeReturnTo);
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
        <Wordmark size={26} href={null} className="tracking-[-0.02em] w-fit" />
        <p className="text-[13px] text-text-2 mt-[5px]">Host sign-in</p>
        <label
          htmlFor="password"
          className="block text-[11px] font-semibold text-text-3 uppercase tracking-[0.08em] mt-[30px] mb-2"
        >
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className="w-full px-3.5 py-2.5 text-sm font-sans bg-card text-text rounded-[8px] outline-none border transition-[border-color] duration-150"
          style={{ borderColor: focused ? "var(--border-hi)" : "var(--border)" }}
        />
        {error && (
          <p className="text-sm text-rec mt-3" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={pending || password.length === 0}
          className="w-full mt-4 py-[11px] text-[15px] font-semibold font-sans rounded-[10px] bg-accent text-accent-ink hover:bg-accent-hi disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {pending ? "Signing in…" : "Sign in"}
        </button>
        <p className="text-xs text-text-3 mt-[22px] leading-normal">
          Guests: use the invite link from your host — no password needed.
        </p>
      </form>
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  );
}
