import { NextRequest, NextResponse } from "next/server";
import { resolvePrincipal } from "@/lib/auth";

// Thin endpoint so client UI can branch on principal (host vs guest for a
// given session) without duplicating the cookie-verification logic. Guests
// are scoped to a single session, so the caller passes the sessionId as a
// query param when it wants guest detection.
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId") ?? undefined;
  const principal = await resolvePrincipal(req, sessionId);
  if (!principal) {
    return NextResponse.json({ role: null }, { status: 200 });
  }
  if (principal.kind === "host") {
    return NextResponse.json({ role: "host" });
  }
  return NextResponse.json({
    role: "guest",
    sessionId: principal.sessionId,
    name: principal.name,
  });
}
