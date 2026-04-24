import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const session = await db.session.findUnique({
      where: { id },
      include: {
        tracks: { orderBy: { createdAt: "asc" } },
      },
    });

    if (!session) {
      return NextResponse.json(
        { error: "Session not found" },
        { status: 404 }
      );
    }

    if (session.status === "ready") {
      return NextResponse.json(session, { status: 200 });
    }

    const pending = session.tracks
      .filter((t) => t.status !== "complete")
      .map((t) => ({
        trackId: t.id,
        participantName: t.participantName,
        status: t.status,
      }));

    if (pending.length > 0) {
      return NextResponse.json({ pending }, { status: 409 });
    }

    const updated = await db.session.update({
      where: { id },
      data: { status: "ready", finalizedAt: new Date() },
      include: {
        tracks: { orderBy: { createdAt: "asc" } },
      },
    });

    return NextResponse.json(updated, { status: 200 });
  } catch (error) {
    console.error("Failed to finalize session:", error);
    return NextResponse.json(
      { error: "Failed to finalize session" },
      { status: 500 }
    );
  }
}
