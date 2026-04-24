import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIES, AUTH_TTLS, issueHostSessionCookie } from "@/lib/auth";
import { verifyHostPassword } from "@/lib/auth-password";

// Naive in-memory rate limit per IP. Good enough for a single-host deployment;
// swap for a shared store if we ever run multi-instance.
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 10 * 60 * 1000; // 10 min
const MAX_ATTEMPTS = 10;

function rateLimit(ip: string): boolean {
  const now = Date.now();
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
  if (!verifyHostPassword(password)) {
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
