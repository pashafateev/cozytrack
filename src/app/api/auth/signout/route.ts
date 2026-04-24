import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIES, isGuestCookieName } from "@/lib/auth";

// Sign-out is a state-changing action, so it's POST-only. GET would be
// triggerable by link prefetchers, crawlers, or cross-site navigations
// (SameSite=Lax still allows top-level GETs), causing surprise logouts.
// The UI uses a <form method="post"> in the Topbar.

export async function POST(req: NextRequest) {
  const res = NextResponse.redirect(new URL("/signin", req.url), { status: 303 });
  res.cookies.delete(AUTH_COOKIES.host);
  for (const c of req.cookies.getAll()) {
    if (isGuestCookieName(c.name)) res.cookies.delete(c.name);
  }
  return res;
}

export function GET() {
  // Refuse state-changing GETs explicitly so accidental visits (browser
  // history, prefetch, curl) don't silently log the user out.
  return new NextResponse("Method Not Allowed. Use POST.", {
    status: 405,
    headers: { Allow: "POST" },
  });
}
