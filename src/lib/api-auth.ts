import type { NextRequest } from "next/server";

const LOCAL_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function getClientAddr(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return null;
}

function isLocalRequest(req: NextRequest): boolean {
  const addr = getClientAddr(req);
  if (addr && LOCAL_ADDRS.has(addr)) return true;
  // When no forwarding header is set, Next.js dev server is local by default.
  if (!addr) return true;
  return false;
}

export function isApiAuthorized(req: NextRequest): boolean {
  if (process.env.NODE_ENV === "development" && isLocalRequest(req)) {
    return true;
  }

  const expected = process.env.COZYTRACK_API_KEY;
  if (!expected) return false;

  const provided = req.headers.get("x-api-key");
  return provided === expected;
}
