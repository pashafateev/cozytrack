import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { deleteTrackChunks, trackRecordingKey } from "@/lib/s3";
import { resolvePrincipal, verifyRecordingUploadToken } from "@/lib/auth";

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

    const principal = await resolvePrincipal(req, sessionId);
    if (principal?.kind === "guest" && principal.sessionId !== sessionId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (!principal) {
      const token = req.headers.get("x-cozytrack-recording-token") ?? undefined;
      const uploadPrincipal = await verifyRecordingUploadToken(
        token,
        sessionId,
        trackId,
      );
      if (!uploadPrincipal) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      }
    }

    const existingTrack = await db.track.findUnique({
      where: { id: trackId },
      select: { sessionId: true },
    });
    if (!existingTrack) {
      return NextResponse.json({ error: "Track not found" }, { status: 404 });
    }
    if (existingTrack.sessionId !== sessionId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
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

    // After completion, recording.webm is the only authoritative artifact.
    // Chunk files are temporary crash-safety uploads and can be discarded.
    await deleteTrackChunks(sessionId, trackId);

    return NextResponse.json(track);
  } catch (error) {
    console.error("Failed to complete upload:", error);
    return NextResponse.json(
      { error: "Failed to complete upload" },
      { status: 500 }
    );
  }
}
