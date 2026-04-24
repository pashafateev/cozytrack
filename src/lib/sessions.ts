import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

const ALLOWED_STATUSES = new Set(["recording", "ready"]);

export async function listSessions(req: NextRequest): Promise<NextResponse> {
  const statusFilter = req.nextUrl.searchParams.get("status");

  if (statusFilter !== null && !ALLOWED_STATUSES.has(statusFilter)) {
    return NextResponse.json(
      { error: "Invalid status filter" },
      { status: 400 }
    );
  }

  const sessions = await db.session.findMany({
    where: statusFilter ? { status: statusFilter } : undefined,
    include: {
      tracks: {
        select: {
          id: true,
          participantName: true,
          status: true,
          durationMs: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(sessions);
}

export async function getSession(id: string): Promise<NextResponse> {
  const session = await db.session.findUnique({
    where: { id },
    include: {
      tracks: {
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!session) {
    return NextResponse.json(
      { error: "Session not found" },
      { status: 404 }
    );
  }

  return NextResponse.json(session);
}
