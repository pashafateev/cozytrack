import { NextRequest, NextResponse } from "next/server";
import { issueGuestSessionCookie, verifyInviteToken } from "@/lib/auth";

export async function POST(req: NextRequest) {
  let body: { token?: unknown; name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token : "";
  const rawName = typeof body.name === "string" ? body.name.trim() : "";
  if (!token || !rawName) {
    return NextResponse.json({ error: "token and name are required" }, { status: 400 });
  }
  const name = rawName.slice(0, 80);

  const payload = await verifyInviteToken(token);
  if (!payload) {
    return NextResponse.json({ error: "Invite invalid or expired" }, { status: 401 });
  }

  const { cookieName, value, ttl } = await issueGuestSessionCookie(payload.sessionId, name);

  const res = NextResponse.json({ ok: true, sessionId: payload.sessionId });
  res.cookies.set(cookieName, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ttl,
  });
  return res;
}
