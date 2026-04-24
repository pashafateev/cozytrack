import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIES, AUTH_TTLS, issueHostSessionCookie } from "@/lib/auth";
import { verifyHostPassword } from "@/lib/auth-password";

// Best-effort in-memory rate limit per IP. On Vercel this is per-instance and
// resets on cold start, so it will NOT stop a determined online brute-forcer
// across instances. It's defense-in-depth on top of the slow KDF in
// auth-password.ts (scrypt) and the configured HOST_PASSWORD entropy.
//
// For a hard guarantee, put this app behind a WAF or rate-limit at the edge
// (Vercel Firewall / Cloudflare) and/or swap this map for a shared store
// (Vercel KV, Upstash Redis).
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 10 * 60 * 1000; // 10 min
const MAX_ATTEMPTS = 10;
const MAX_TRACKED_IPS = 10_000; // cap to prevent unbounded memory growth

function evictExpired(now: number) {
  // Cheap sweep: only run when we'd otherwise blow the cap.
  if (attempts.size < MAX_TRACKED_IPS) return;
  for (const [ip, rec] of attempts) {
    if (rec.resetAt < now) attempts.delete(ip);
    if (attempts.size < MAX_TRACKED_IPS) break;
  }
  // If still over cap (all entries live), drop oldest insertions.
  while (attempts.size >= MAX_TRACKED_IPS) {
    const first = attempts.keys().next().value;
    if (first === undefined) break;
    attempts.delete(first);
  }
}

function rateLimit(ip: string): boolean {
  const now = Date.now();
  evictExpired(now);
  const rec = attempts.get(ip);
  if (!rec || rec.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  rec.count += 1;
  return rec.count <= MAX_ATTEMPTS;
}

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";

  if (!rateLimit(ip)) {
    return NextResponse.json(
      { error: "Too many attempts. Try again in a few minutes." },
      { status: 429 },
    );
  }

  let body: { password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const password = typeof body.password === "string" ? body.password : "";
  let ok: boolean;
  try {
    ok = verifyHostPassword(password);
  } catch (err) {
    // HOST_PASSWORD misconfigured (e.g. too short). Surface to logs, 500 to client.
    console.error("[auth] verifyHostPassword threw:", err);
    return NextResponse.json({ error: "Auth misconfigured" }, { status: 500 });
  }
  if (!ok) {
    // Uniform 401 + delay to reduce signal from timing
    await new Promise((r) => setTimeout(r, 250));
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  const token = await issueHostSessionCookie();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIES.host, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_TTLS.hostSession,
  });
  return res;
}
