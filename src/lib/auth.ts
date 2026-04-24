// Interim auth for cozytrack. Two principals:
//   - host: a single password-authenticated operator (you). Signed session cookie.
//   - guest: per-session invite token. Signed JWT in URL, exchanged for a scoped cookie.
//
// Both use the same primitive: HS256 JWT via `jose`. When podflow ships as IdP
// (see issue #36), verifyHostSession() gets replaced by verifyPodflowToken()
// and the rest of this file can stay.

import { SignJWT, jwtVerify } from "jose";
import { NextRequest } from "next/server";
import { cookies } from "next/headers";

const HOST_COOKIE = "cozytrack_host";
const GUEST_COOKIE_PREFIX = "cozytrack_guest_"; // + sessionId

const HOST_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const GUEST_SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours
const INVITE_TOKEN_TTL_SECONDS = 60 * 60 * 48; // 48 hours

export type HostPrincipal = { kind: "host" };
export type GuestPrincipal = { kind: "guest"; sessionId: string; name: string };
export type Principal = HostPrincipal | GuestPrincipal;

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "AUTH_SECRET env var must be set to a 32+ character random string. Generate with: openssl rand -hex 32",
    );
  }
  return new TextEncoder().encode(secret);
}

// ---------- Host sessions ----------

export async function issueHostSessionCookie(): Promise<string> {
  return await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("cozytrack")
    .setAudience("cozytrack:host")
    .setSubject("host")
    .setIssuedAt()
    .setExpirationTime(`${HOST_SESSION_TTL_SECONDS}s`)
    .sign(getSecret());
}

export async function verifyHostCookie(token: string | undefined): Promise<HostPrincipal | null> {
  if (!token) return null;
  try {
    await jwtVerify(token, getSecret(), {
      issuer: "cozytrack",
      audience: "cozytrack:host",
    });
    return { kind: "host" };
  } catch {
    return null;
  }
}

// ---------- Guest invite tokens ----------

export async function mintInviteToken(sessionId: string): Promise<string> {
  return await new SignJWT({ sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("cozytrack")
    .setAudience("cozytrack:invite")
    .setIssuedAt()
    .setExpirationTime(`${INVITE_TOKEN_TTL_SECONDS}s`)
    .sign(getSecret());
}

export async function verifyInviteToken(token: string): Promise<{ sessionId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: "cozytrack",
      audience: "cozytrack:invite",
    });
    if (typeof payload.sessionId !== "string") return null;
    return { sessionId: payload.sessionId };
  } catch {
    return null;
  }
}

// ---------- Guest sessions (post-invite-acceptance) ----------

export async function issueGuestSessionCookie(
  sessionId: string,
  name: string,
): Promise<{ cookieName: string; value: string; ttl: number }> {
  const value = await new SignJWT({ sessionId, name })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("cozytrack")
    .setAudience("cozytrack:guest")
    .setSubject(`guest:${sessionId}`)
    .setIssuedAt()
    .setExpirationTime(`${GUEST_SESSION_TTL_SECONDS}s`)
    .sign(getSecret());
  return { cookieName: guestCookieName(sessionId), value, ttl: GUEST_SESSION_TTL_SECONDS };
}

export async function verifyGuestCookie(
  token: string | undefined,
  sessionId: string,
): Promise<GuestPrincipal | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: "cozytrack",
      audience: "cozytrack:guest",
    });
    if (payload.sessionId !== sessionId) return null;
    const name = typeof payload.name === "string" ? payload.name : "Guest";
    return { kind: "guest", sessionId, name };
  } catch {
    return null;
  }
}

function guestCookieName(sessionId: string): string {
  // Cookie names are per-session so a guest invited to one session doesn't
  // accidentally carry credentials into another.
  return `${GUEST_COOKIE_PREFIX}${sessionId}`;
}

/** True if the cookie name belongs to a guest session. Safe for middleware/Edge. */
export function isGuestCookieName(name: string): boolean {
  return name.startsWith(GUEST_COOKIE_PREFIX);
}

// ---------- Request-level helpers ----------

/**
 * Resolves the caller for a given request + session scope.
 *
 * - Host cookie always wins (hosts can access any session).
 * - Guest cookie is accepted only if it matches the requested sessionId.
 * - Returns null if neither applies.
 */
export async function resolvePrincipal(
  req: NextRequest,
  sessionId?: string,
): Promise<Principal | null> {
  const host = await verifyHostCookie(req.cookies.get(HOST_COOKIE)?.value);
  if (host) return host;

  if (sessionId) {
    const guestCookie = req.cookies.get(guestCookieName(sessionId))?.value;
    const guest = await verifyGuestCookie(guestCookie, sessionId);
    if (guest) return guest;
  }

  return null;
}

/** Server-component / route-handler variant using next/headers cookies() */
export async function resolvePrincipalFromCookies(sessionId?: string): Promise<Principal | null> {
  const jar = await cookies();
  const host = await verifyHostCookie(jar.get(HOST_COOKIE)?.value);
  if (host) return host;

  if (sessionId) {
    const guest = await verifyGuestCookie(jar.get(guestCookieName(sessionId))?.value, sessionId);
    if (guest) return guest;
  }
  return null;
}

export const AUTH_COOKIES = {
  host: HOST_COOKIE,
  guestPrefix: GUEST_COOKIE_PREFIX,
  guest: guestCookieName,
} as const;

export const AUTH_TTLS = {
  hostSession: HOST_SESSION_TTL_SECONDS,
  guestSession: GUEST_SESSION_TTL_SECONDS,
  invite: INVITE_TOKEN_TTL_SECONDS,
} as const;
