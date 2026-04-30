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

    if (session.status !== "ready") {
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

      await db.session.updateMany({
        where: { id, status: "recording" },
        data: { status: "ready", finalizedAt: new Date() },
      });
    }

    const updated = await db.session.findUnique({
      where: { id },
      include: {
        tracks: { orderBy: { createdAt: "asc" } },
      },
    });

    if (!updated) {
      return NextResponse.json(
        { error: "Session not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(updated, { status: 200 });
  } catch (error) {
    console.error("Failed to finalize session:", error);
    return NextResponse.json(
      { error: "Failed to finalize session" },
      { status: 500 }
    );
  }
}
