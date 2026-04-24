import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { AUTH_COOKIES, verifyHostCookie } from "@/lib/auth";

async function requireHost(req: NextRequest): Promise<boolean> {
  const host = await verifyHostCookie(req.cookies.get(AUTH_COOKIES.host)?.value);
  return Boolean(host);
}

export async function POST(req: NextRequest) {
  if (!(await requireHost(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const body = await req.json();
    const { name } = body;

    if (!name || typeof name !== "string") {
      return NextResponse.json(
        { error: "Session name is required" },
        { status: 400 }
      );
    }

    const session = await db.session.create({
      data: { name },
    });

    return NextResponse.json(session, { status: 201 });
  } catch (error) {
    console.error("Failed to create session:", error);
    return NextResponse.json(
      { error: "Failed to create session" },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  if (!(await requireHost(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const statusFilter = req.nextUrl.searchParams.get("status");

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
  } catch (error) {
    console.error("Failed to list sessions:", error);
    return NextResponse.json(
      { error: "Failed to list sessions" },
      { status: 500 }
    );
  }
}
