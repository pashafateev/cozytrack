import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  deleteTrackSegmentChunks,
  trackRecordingKey,
  trackSegmentRecordingKey,
} from "@/lib/s3";
import { resolvePrincipal, verifyRecordingUploadToken } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { sessionId, trackId, durationMs } = body;
    const segmentId =
      typeof body?.segmentId === "string" && body.segmentId.length > 0
        ? body.segmentId
        : trackId;

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

    const existingSegment = await db.trackSegment.findUnique({
      where: { id: segmentId },
      select: { trackId: true },
    });
    if (!existingSegment) {
      return NextResponse.json({ error: "Track segment not found" }, { status: 404 });
    }
    if (existingSegment.trackId !== trackId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const s3Key = trackRecordingKey(sessionId, trackId);
    await db.trackSegment.update({
      where: { id: segmentId },
      data: {
        status: "complete",
        durationMs: durationMs ?? null,
        completedAt: new Date(),
      },
    });

    const segmentRecordingKey = trackSegmentRecordingKey(
      sessionId,
      trackId,
      segmentId,
    );
    const isDefaultSegment = segmentRecordingKey === s3Key;

    const track = await db.track.update({
      where: { id: trackId },
      data: isDefaultSegment
        ? {
            status: "complete",
            s3Key: s3Key,
            durationMs: durationMs ?? null,
            // Reset any premature partial flag from racing recovery — the client
            // successfully produced and uploaded its merged blob.
            partial: false,
          }
        : {
            status: "uploading",
            s3Key: s3Key,
          },
    });

    // After segment completion, recording.webm is the authoritative artifact
    // for that segment. Chunk files are temporary crash-safety uploads and can
    // be discarded.
    await deleteTrackSegmentChunks(sessionId, trackId, segmentId);

    return NextResponse.json(track);
  } catch (error) {
    console.error("Failed to complete upload:", error);
    return NextResponse.json(
      { error: "Failed to complete upload" },
      { status: 500 }
    );
  }
}
