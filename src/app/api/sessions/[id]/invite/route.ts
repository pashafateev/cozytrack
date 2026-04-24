import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { AUTH_TTLS, mintInviteToken, verifyHostCookie, AUTH_COOKIES } from "@/lib/auth";

/**
 * Host-only. Mints a signed invite token for a specific session and returns
 * a shareable URL. The token is not persisted — invites are stateless and
 * expire in AUTH_TTLS.invite seconds.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const host = await verifyHostCookie(req.cookies.get(AUTH_COOKIES.host)?.value);
  if (!host) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const session = await db.session.findUnique({ where: { id }, select: { id: true } });
  if (!session) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }

  const token = await mintInviteToken(id);
  const origin = req.nextUrl.origin;
  const url = `${origin}/join/${token}`;

  return NextResponse.json({
    url,
    expiresInSeconds: AUTH_TTLS.invite,
  });
}
