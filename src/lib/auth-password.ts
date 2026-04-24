// Password verification helpers. Isolated from src/lib/auth because this file
// imports node:crypto, which is not available in the Edge runtime (where
// middleware runs). The signin route pulls this in; middleware does not.

import { createHash, timingSafeEqual } from "node:crypto";

function getHostPasswordHash(): Buffer | null {
  const pw = process.env.HOST_PASSWORD;
  if (!pw) return null;
  return createHash("sha256").update(pw).digest();
}

export function verifyHostPassword(candidate: string): boolean {
  const expected = getHostPasswordHash();
  if (!expected) return false;
  const got = createHash("sha256").update(candidate).digest();
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}
