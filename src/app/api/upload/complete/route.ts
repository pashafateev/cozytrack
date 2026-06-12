import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  deleteTrackSegmentChunks,
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

    await db.trackSegment.update({
      where: { id: segmentId },
      data: {
        status: "complete",
        durationMs: durationMs ?? null,
        completedAt: new Date(),
      },
    });

    const segments = await db.trackSegment.findMany({
      where: { trackId },
      orderBy: { segmentIndex: "asc" },
      select: { id: true, status: true, durationMs: true },
    });
    // Interim semantics until media stitching lands (#111 stack 4): the latest
    // segment's recording is the track's authoritative artifact. Earlier
    // segments stay in S3 and in TrackSegment rows for the future stitcher.
    // The track is done once its newest segment is — older incomplete
    // segments are superseded attempts (sequential per participant) and must
    // not park the track in uploading; only a newer in-flight segment may.
    const latestSegment = segments[segments.length - 1];
    const latestSegmentComplete = latestSegment.status === "complete";

    let track;
    if (latestSegmentComplete) {
      track = await db.track.update({
        where: { id: trackId },
        data: {
          status: "complete",
          s3Key: trackSegmentRecordingKey(
            sessionId,
            trackId,
            latestSegment.id,
          ),
          durationMs: latestSegment.durationMs ?? null,
          // Reset any premature partial flag from racing recovery — the client
          // successfully produced and uploaded its merged blob.
          partial: false,
        },
      });
    } else {
      // Conditional write: an older segment's completion can read the
      // segment list before a concurrent newest-segment completion commits.
      // It must not demote the track that completion already promoted —
      // that would strand a fully-complete track in uploading.
      await db.track.updateMany({
        where: { id: trackId, status: { not: "complete" } },
        data: { status: "uploading" },
      });
      track = await db.track.findUnique({ where: { id: trackId } });
    }

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
