// Password verification helpers. Isolated from src/lib/auth because this file
// imports node:crypto, which is not available in the Edge runtime (where
// middleware runs). The signin route pulls this in; middleware does not.
//
// We use scrypt (slow KDF) rather than a raw SHA-256 so that if the
// per-instance rate limit in /api/auth/signin is bypassed (multi-instance
// cold starts, distributed attack), brute-forcing stays expensive.

import { scryptSync, timingSafeEqual } from "node:crypto";

// A fixed salt is fine here: there's a single secret we're hashing (not a
// user database), and the salt only exists to stop rainbow tables. If we
// ever grow to per-user passwords, switch to a per-row random salt stored
// alongside the hash.
const SCRYPT_SALT = "cozytrack.host-password.v1";
const SCRYPT_KEYLEN = 32;
// N=16384 is scrypt's interactive-login default (~30ms on a modern CPU).
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 } as const;

const MIN_PASSWORD_LENGTH = 12;

let cachedHash: Buffer | null | undefined;

function getHostPasswordHash(): Buffer | null {
  if (cachedHash !== undefined) return cachedHash;
  const pw = process.env.HOST_PASSWORD;
  if (!pw) {
    cachedHash = null;
    return cachedHash;
  }
  if (pw.length < MIN_PASSWORD_LENGTH) {
    // Fail loudly at first use so a weak password is caught in deploy, not
    // discovered by an attacker. The signin route surfaces this as a 500.
    throw new Error(
      `HOST_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters. Generate one with: openssl rand -hex 24`,
    );
  }
  cachedHash = scryptSync(pw, SCRYPT_SALT, SCRYPT_KEYLEN, SCRYPT_OPTS) as Buffer;
  return cachedHash;
}

export function verifyHostPassword(candidate: string): boolean {
  const expected = getHostPasswordHash();
  if (!expected) return false;
  // Short-circuit on wildly wrong lengths without running scrypt, since the
  // KDF is intentionally expensive. This does leak "password length looks
  // plausible" via timing, but callers already see "401 invalid" either way.
  if (candidate.length === 0 || candidate.length > 256) return false;
  const got = scryptSync(candidate, SCRYPT_SALT, SCRYPT_KEYLEN, SCRYPT_OPTS) as Buffer;
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}
