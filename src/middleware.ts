// Strict lockdown middleware.
//
// Policy:
//   - Public: /signin (host login), /join/[token] (guest invite landing),
//             /api/auth/* (login/logout/accept), plus Next internals.
//   - Everything else requires EITHER a valid host cookie OR, when the URL
//     names a specific session, a matching guest cookie.
//
// Session-scoped paths ({/studio,/session,/api/sessions,/api/tracks}/:id/...):
//   host cookie always grants access; guest cookie grants only if its
//   sessionId matches the URL path segment.
//
// Every other API/page route requires host auth.

import { NextRequest, NextResponse } from "next/server";
import { verifyHostCookie, verifyGuestCookie, AUTH_COOKIES } from "@/lib/auth";

const PUBLIC_PATHS = [
  "/signin",
  "/api/auth/signin",
  "/api/auth/signout",
  "/api/auth/accept-invite",
];

const PUBLIC_PREFIXES = ["/join/", "/_next/", "/favicon.ico"];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Extract the session id from a URL if it's a session-scoped route.
 * Returns null for routes that are not session-scoped.
 */
function extractSessionId(pathname: string): string | null {
  // /studio/<id>, /session/<id>, /api/sessions/<id>/..., /api/tracks/<trackId>/...
  // Tracks are not session-scoped in the URL — they only accept host auth.
  const sessionMatch =
    pathname.match(/^\/studio\/([^/]+)/) ??
    pathname.match(/^\/session\/([^/]+)/) ??
    pathname.match(/^\/api\/sessions\/([^/]+)/);
  return sessionMatch?.[1] ?? null;
}

/**
 * Is this a session-scoped write endpoint where a guest (in that session)
 * should be allowed through? Upload presign/complete accept guest auth;
 * the caller proves scope by including the sessionId in the body — but
 * middleware can only check cookie-vs-URL, so we accept any guest cookie
 * here and let the route handler enforce sessionId matching.
 */
function isGuestAllowedForSessionEndpoint(pathname: string): boolean {
  return (
    pathname === "/api/upload/presign" ||
    pathname === "/api/upload/complete" ||
    pathname === "/api/livekit-token"
  );
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const hostCookie = req.cookies.get(AUTH_COOKIES.host)?.value;
  const host = await verifyHostCookie(hostCookie);
  if (host) return NextResponse.next();

  // Session-scoped route: accept a matching guest cookie.
  const sessionId = extractSessionId(pathname);
  if (sessionId) {
    const guestCookie = req.cookies.get(AUTH_COOKIES.guest(sessionId))?.value;
    const guest = await verifyGuestCookie(guestCookie, sessionId);
    if (guest) return NextResponse.next();
  }

  // Guest-allowed upload endpoints: the route handler inspects the request
  // body and matches it to the guest cookie. Middleware can't read the body
  // (streams aren't cloneable here), so we let any request with *some* guest
  // cookie continue to the handler, which does the real check.
  if (isGuestAllowedForSessionEndpoint(pathname)) {
    const guestCookies = req.cookies
      .getAll()
      .filter((c) => c.name.startsWith("cozytrack_guest_"));
    if (guestCookies.length > 0) {
      return NextResponse.next();
    }
  }

  // API routes return JSON 401; pages redirect to sign-in.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const signinUrl = new URL("/signin", req.url);
  signinUrl.searchParams.set("return_to", pathname + req.nextUrl.search);
  return NextResponse.redirect(signinUrl);
}

export const config = {
  matcher: [
    // Match everything except static assets and image optimizer
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
