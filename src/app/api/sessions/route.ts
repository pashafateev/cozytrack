import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function POST(req: NextRequest) {
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

export async function GET() {
  try {
    const sessions = await db.session.findMany({
      include: {
        tracks: {
          select: { id: true, participantName: true, status: true },
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
