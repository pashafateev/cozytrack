import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIES } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(AUTH_COOKIES.host);
  // Also clear any guest cookies on this client.
  for (const c of req.cookies.getAll()) {
    if (c.name.startsWith("cozytrack_guest_")) {
      res.cookies.delete(c.name);
    }
  }
  return res;
}

// Allow GET for a simple sign-out link that redirects back to /signin.
export async function GET(req: NextRequest) {
  const res = NextResponse.redirect(new URL("/signin", req.url));
  res.cookies.delete(AUTH_COOKIES.host);
  for (const c of req.cookies.getAll()) {
    if (c.name.startsWith("cozytrack_guest_")) {
      res.cookies.delete(c.name);
    }
  }
  return res;
}
