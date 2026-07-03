import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { deleteTrackSegmentChunks } from "@/lib/s3";
import { resolvePrincipal, verifyRecordingUploadToken } from "@/lib/auth";
import { materializeTrack } from "@/lib/track-materialization";
import {
  claimRecordingSessionForWrite,
  FINALIZED_SESSION_ERROR,
  type RecordingSessionWriteClaim,
} from "@/lib/session-status";

function recordingSessionWriteErrorResponse(
  claim: RecordingSessionWriteClaim,
  sessionId: string,
) {
  if (claim.ok) return null;
  if (claim.reason === "missing") {
    return NextResponse.json(
      { error: `Session ${sessionId} was not found` },
      { status: 404 },
    );
  }
  return NextResponse.json(
    { error: FINALIZED_SESSION_ERROR },
    { status: 409 },
  );
}

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
        segmentId,
      );
      if (!uploadPrincipal) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      }
    }

    return await db.$transaction(async (tx) => {
      const claim = await claimRecordingSessionForWrite(tx, sessionId);
      const claimError = recordingSessionWriteErrorResponse(claim, sessionId);
      if (claimError) return claimError;

      const existingTrack = await tx.track.findUnique({
        where: { id: trackId },
        select: { sessionId: true },
      });
      if (!existingTrack) {
        return NextResponse.json({ error: "Track not found" }, { status: 404 });
      }
      if (existingTrack.sessionId !== sessionId) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }

      const existingSegment = await tx.trackSegment.findUnique({
        where: { id: segmentId },
        select: { trackId: true },
      });
      if (!existingSegment) {
        return NextResponse.json(
          { error: "Track segment not found" },
          { status: 404 },
        );
      }
      if (existingSegment.trackId !== trackId) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }

      await tx.trackSegment.update({
        where: { id: segmentId },
        data: {
          status: "complete",
          durationMs: durationMs ?? null,
          completedAt: new Date(),
        },
      });

      const segments = await tx.trackSegment.findMany({
        where: { trackId },
        orderBy: { segmentIndex: "asc" },
        select: {
          id: true,
          status: true,
          durationMs: true,
          segmentIndex: true,
        },
      });
      // The logical track is complete only after materialization creates the
      // downstream-facing artifact at the logical track key. Older incomplete
      // segments are superseded attempts and do not block a newer complete
      // segment, but a newer in-flight segment keeps the logical track pending.
      const latestSegment = segments[segments.length - 1];
      const latestSegmentComplete = latestSegment.status === "complete";

      let track;
      if (latestSegmentComplete) {
        await materializeTrack(trackId, { dbClient: tx });
        track = await tx.track.findUnique({ where: { id: trackId } });
      } else {
        // Conditional write: an older segment's completion can read the
        // segment list before a concurrent newest-segment completion commits.
        // It must not demote the track that completion already promoted —
        // that would strand a fully-complete track in uploading.
        await tx.track.updateMany({
          where: { id: trackId, status: { not: "complete" } },
          data: { status: "uploading" },
        });
        track = await tx.track.findUnique({ where: { id: trackId } });
      }

      // After segment completion, recording.webm is the authoritative artifact
      // for that segment. Chunk files are temporary crash-safety uploads and can
      // be discarded.
      await deleteTrackSegmentChunks(sessionId, trackId, segmentId);

      return NextResponse.json(track);
    });
  } catch (error) {
    console.error("Failed to complete upload:", error);
    return NextResponse.json(
      { error: "Failed to complete upload" },
      { status: 500 }
    );
  }
}
