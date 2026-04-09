import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackRecordingKey } from "@/lib/s3";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { sessionId, trackId, durationMs } = body;

    if (!sessionId || !trackId) {
      return NextResponse.json(
        { error: "sessionId and trackId are required" },
        { status: 400 }
      );
    }

    const s3Key = trackRecordingKey(sessionId, trackId);

    const track = await db.track.update({
      where: { id: trackId },
      data: {
        status: "complete",
        s3Key: s3Key,
        durationMs: durationMs ?? null,
      },
    });

    return NextResponse.json(track);
  } catch (error) {
    console.error("Failed to complete upload:", error);
    return NextResponse.json(
      { error: "Failed to complete upload" },
      { status: 500 }
    );
  }
}
