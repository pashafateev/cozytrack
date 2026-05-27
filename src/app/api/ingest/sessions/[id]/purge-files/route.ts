import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { deleteSessionObjects } from "@/lib/s3";

function latestPurgedAt(
  tracks: Array<{ s3PurgedAt: Date | null }>
): Date | null {
  return tracks.reduce<Date | null>((latest, track) => {
    if (!track.s3PurgedAt) {
      return latest;
    }

    if (!latest || track.s3PurgedAt > latest) {
      return track.s3PurgedAt;
    }

    return latest;
  }, null);
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const session = await db.session.findUnique({
      where: { id },
      include: {
        tracks: {
          select: {
            id: true,
            s3PurgedAt: true,
          },
        },
      },
    });

    if (!session) {
      return NextResponse.json(
        { error: "Session not found" },
        { status: 404 }
      );
    }

    if (session.status !== "ready") {
      return NextResponse.json(
        { error: "Session is not ready" },
        { status: 409 }
      );
    }

    const existingPurgedAt = latestPurgedAt(session.tracks);
    const alreadyPurged =
      session.tracks.length > 0 &&
      session.tracks.every((track) => track.s3PurgedAt);

    if (alreadyPurged && existingPurgedAt) {
      return NextResponse.json({
        sessionId: id,
        deletedObjects: 0,
        purgedTracks: 0,
        s3PurgedAt: existingPurgedAt,
      });
    }

    const deletedObjects = await deleteSessionObjects(id);
    const s3PurgedAt = new Date();

    const updateResult = await db.track.updateMany({
      where: { sessionId: id, s3PurgedAt: null },
      data: { s3PurgedAt },
    });

    return NextResponse.json({
      sessionId: id,
      deletedObjects,
      purgedTracks: updateResult.count,
      s3PurgedAt,
    });
  } catch (error) {
    console.error("Failed to purge session files:", error);
    return NextResponse.json(
      { error: "Failed to purge session files" },
      { status: 500 }
    );
  }
}
