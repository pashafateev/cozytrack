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
const HOST_SESSION_RENEW_AFTER_SECONDS = 60 * 60 * 24; // 24 hours
const GUEST_SESSION_RENEW_AFTER_SECONDS = 60 * 60; // 1 hour
const HOST_SESSION_ABSOLUTE_CAP_SECONDS = 60 * 60 * 24 * 30; // 30 days
const GUEST_SESSION_ABSOLUTE_CAP_SECONDS = 60 * 60 * 48; // 48 hours
const INVITE_TOKEN_TTL_SECONDS = 60 * 60 * 48; // 48 hours
const RECORDING_UPLOAD_TTL_SECONDS = 60 * 60 * 12; // 12 hours
const HOST_PARTICIPANT_ID = "host";

type SessionTiming = {
  /** JWT issue time. Optional so existing test doubles remain compatible. */
  issuedAt?: number;
  /** Original issue time, preserved through sliding renewals. */
  firstIssuedAt?: number;
};

export type HostPrincipal = SessionTiming & {
  kind: "host";
  participantId: typeof HOST_PARTICIPANT_ID;
};
export type GuestPrincipal = {
  kind: "guest";
  sessionId: string;
  name: string;
  participantId: string;
} & SessionTiming;
export type Principal = HostPrincipal | GuestPrincipal;
export type RecordingUploadPrincipal = {
  kind: "recording_upload";
  sessionId: string;
  trackId: string;
};
export type SessionCookieRenewal = {
  value: string;
  /** Remaining JWT lifetime; use as the refreshed cookie Max-Age. */
  ttl: number;
};

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

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function numericDate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : undefined;
}

function sessionTiming(payload: {
  iat?: unknown;
  firstIssuedAt?: unknown;
}): SessionTiming {
  const issuedAt = numericDate(payload.iat);
  return {
    issuedAt,
    // Tokens issued before sliding renewal have no firstIssuedAt claim.
    // Their original iat becomes the absolute-cap origin on first renewal.
    firstIssuedAt: numericDate(payload.firstIssuedAt) ?? issuedAt,
  };
}

function renewalTtl(
  principal: SessionTiming,
  input: {
    ttl: number;
    renewAfter: number;
    absoluteCap: number;
  },
): { now: number; firstIssuedAt: number; ttl: number } | null {
  const { issuedAt, firstIssuedAt } = principal;
  if (issuedAt === undefined || firstIssuedAt === undefined) return null;

  const now = nowSeconds();
  if (now - issuedAt < input.renewAfter) return null;

  const absoluteExpiresAt = firstIssuedAt + input.absoluteCap;
  if (now >= absoluteExpiresAt) return null;

  // Never mint past the absolute cap. Near the cap, refresh only for the
  // remaining lifetime instead of silently extending the cap by a full TTL.
  const ttl = Math.min(input.ttl, absoluteExpiresAt - now);
  if (ttl <= 0) return null;
  return { now, firstIssuedAt, ttl };
}

async function signHostSession(
  issuedAt: number,
  firstIssuedAt: number,
  ttl: number,
): Promise<string> {
  return await new SignJWT({ firstIssuedAt })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("cozytrack")
    .setAudience("cozytrack:host")
    .setSubject("host")
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttl)
    .sign(getSecret());
}

export async function issueHostSessionCookie(): Promise<string> {
  const issuedAt = nowSeconds();
  return await signHostSession(
    issuedAt,
    issuedAt,
    HOST_SESSION_TTL_SECONDS,
  );
}

export async function verifyHostCookie(token: string | undefined): Promise<HostPrincipal | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: "cozytrack",
      audience: "cozytrack:host",
    });
    return {
      kind: "host",
      participantId: HOST_PARTICIPANT_ID,
      ...sessionTiming(payload),
    };
  } catch {
    return null;
  }
}

export async function renewHostSessionCookie(
  principal: HostPrincipal,
): Promise<SessionCookieRenewal | null> {
  const renewal = renewalTtl(principal, {
    ttl: HOST_SESSION_TTL_SECONDS,
    renewAfter: HOST_SESSION_RENEW_AFTER_SECONDS,
    absoluteCap: HOST_SESSION_ABSOLUTE_CAP_SECONDS,
  });
  if (!renewal) return null;

  return {
    value: await signHostSession(
      renewal.now,
      renewal.firstIssuedAt,
      renewal.ttl,
    ),
    ttl: renewal.ttl,
  };
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
): Promise<{ cookieName: string; value: string; ttl: number; participantId: string }> {
  const participantId = `guest_${globalThis.crypto.randomUUID()}`;
  const issuedAt = nowSeconds();
  const value = await signGuestSession(
    { sessionId, name, participantId },
    issuedAt,
    issuedAt,
    GUEST_SESSION_TTL_SECONDS,
  );
  return {
    cookieName: guestCookieName(sessionId),
    value,
    ttl: GUEST_SESSION_TTL_SECONDS,
    participantId,
  };
}

async function signGuestSession(
  principal: Pick<GuestPrincipal, "sessionId" | "name" | "participantId">,
  issuedAt: number,
  firstIssuedAt: number,
  ttl: number,
): Promise<string> {
  return await new SignJWT({
    sessionId: principal.sessionId,
    name: principal.name,
    participantId: principal.participantId,
    firstIssuedAt,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("cozytrack")
    .setAudience("cozytrack:guest")
    .setSubject(`guest:${principal.sessionId}`)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttl)
    .sign(getSecret());
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
    if (typeof payload.participantId !== "string" || payload.participantId.length === 0) {
      return null;
    }
    return {
      kind: "guest",
      sessionId,
      name,
      participantId: payload.participantId,
      ...sessionTiming(payload),
    };
  } catch {
    return null;
  }
}

export async function renewGuestSessionCookie(
  principal: GuestPrincipal,
): Promise<SessionCookieRenewal | null> {
  const renewal = renewalTtl(principal, {
    ttl: GUEST_SESSION_TTL_SECONDS,
    renewAfter: GUEST_SESSION_RENEW_AFTER_SECONDS,
    absoluteCap: GUEST_SESSION_ABSOLUTE_CAP_SECONDS,
  });
  if (!renewal) return null;

  return {
    value: await signGuestSession(
      principal,
      renewal.now,
      renewal.firstIssuedAt,
      renewal.ttl,
    ),
    ttl: renewal.ttl,
  };
}

export function principalParticipantId(principal: Principal): string {
  return principal.participantId;
}

// ---------- Host-owned local track slots ----------
//
// Two-channel local recording (issue #135) splits one desktop audio interface
// into two host-owned channels. Each channel records as a normal Track, but
// they share the host principal — so they need distinct, stable participant ids
// to coexist under the Track [takeId, participantId] uniqueness constraint. The
// slot id IS the synthetic participant id: deterministic, host-scoped, and not
// derivable by a guest (the server rejects guest-supplied slot ids).

export const LOCAL_TRACK_SLOT_IDS = [
  "host-local-ch-1",
  "host-local-ch-2",
] as const;
export type LocalTrackSlotId = (typeof LOCAL_TRACK_SLOT_IDS)[number];

export function isLocalTrackSlotId(value: unknown): value is LocalTrackSlotId {
  return (
    typeof value === "string" &&
    (LOCAL_TRACK_SLOT_IDS as readonly string[]).includes(value)
  );
}

/**
 * Stable synthetic participant id for a local channel slot. The slot id is
 * already host-scoped and unique per channel, so it doubles as the participant
 * id — keeping the two channels distinct without minting extra identifiers.
 */
export function localTrackSlotParticipantId(slotId: LocalTrackSlotId): string {
  return slotId;
}

// ---------- Recording upload tokens ----------

export async function issueRecordingUploadToken(
  sessionId: string,
  trackId: string,
  segmentId?: string,
): Promise<string> {
  return await new SignJWT({
    sessionId,
    trackId,
    ...(segmentId ? { segmentId } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("cozytrack")
    .setAudience("cozytrack:recording-upload")
    .setSubject(`recording-upload:${sessionId}:${trackId}`)
    .setIssuedAt()
    .setExpirationTime(`${RECORDING_UPLOAD_TTL_SECONDS}s`)
    .sign(getSecret());
}

export async function verifyRecordingUploadToken(
  token: string | undefined,
  sessionId: string,
  trackId: string,
  segmentId?: string,
): Promise<RecordingUploadPrincipal | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: "cozytrack",
      audience: "cozytrack:recording-upload",
    });
    if (payload.sessionId !== sessionId || payload.trackId !== trackId) {
      return null;
    }
    // Tokens minted before segments existed carry no segment claim and stay
    // track-scoped. Segment-scoped tokens only authorize the segment they
    // were issued for — one attempt's token must not write into another's.
    if (
      typeof payload.segmentId === "string" &&
      segmentId !== undefined &&
      payload.segmentId !== segmentId
    ) {
      return null;
    }
    return { kind: "recording_upload", sessionId, trackId };
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
  recordingUpload: RECORDING_UPLOAD_TTL_SECONDS,
} as const;

export const AUTH_RENEWAL = {
  hostAfter: HOST_SESSION_RENEW_AFTER_SECONDS,
  guestAfter: GUEST_SESSION_RENEW_AFTER_SECONDS,
  hostAbsoluteCap: HOST_SESSION_ABSOLUTE_CAP_SECONDS,
  guestAbsoluteCap: GUEST_SESSION_ABSOLUTE_CAP_SECONDS,
} as const;
