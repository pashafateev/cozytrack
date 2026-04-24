import { NextResponse, type NextRequest } from "next/server";
import { isApiAuthorized } from "@/lib/api-auth";

export function middleware(req: NextRequest) {
  if (!isApiAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/api/sessions",
    "/api/sessions/:path*",
    "/api/tracks/:id/download",
  ],
};
