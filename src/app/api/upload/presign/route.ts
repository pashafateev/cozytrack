import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  trackRecordingKey,
  trackSegmentPartKey,
  trackSegmentPrefix,
  trackSegmentRecordingKey,
  getPresignedPutUrl,
} from "@/lib/s3";
import {
  issueRecordingUploadToken,
  principalParticipantId,
  resolvePrincipal,
  type Principal,
  verifyRecordingUploadToken,
} from "@/lib/auth";
import {
  SYNC_MARKER_DURATION_MS,
  SYNC_MARKER_OFFSET_MS,
  SYNC_MARKER_VERSION,
  type SyncMarkerMetadata,
} from "@/lib/sync-marker";
import {
  FINALIZED_SESSION_ERROR,
  isRecordingSession,
} from "@/lib/session-status";

function getUploadErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Failed to generate presigned URL";
  }

  if (
    error.name === "CredentialsProviderError" ||
    error.message.includes("session has expired")
  ) {
    return "AWS session expired. Reauthenticate with `aws login` and try again.";
  }

  return "Failed to generate presigned URL";
}

function cleanNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function cleanSyncMarker(value: unknown): SyncMarkerMetadata | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") {
    throw new Error("SYNC_MARKER_INVALID");
  }

  const marker = value as {
    version?: unknown;
    offsetMs?: unknown;
    durationMs?: unknown;
  };
  if (
    marker.version !== SYNC_MARKER_VERSION ||
    marker.offsetMs !== SYNC_MARKER_OFFSET_MS ||
    marker.durationMs !== SYNC_MARKER_DURATION_MS
  ) {
    throw new Error("SYNC_MARKER_INVALID");
  }

  return {
    version: SYNC_MARKER_VERSION,
    offsetMs: SYNC_MARKER_OFFSET_MS,
    durationMs: SYNC_MARKER_DURATION_MS,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

async function findActiveTake(sessionId: string): Promise<{ id: string } | null> {
  return await db.recordingTake.findFirst({
    where: { sessionId, stoppedAt: null },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
}

async function ensureLogicalTrackAndSegment(input: {
  sessionId: string;
  requestedTrackId: string;
  requestedSegmentId: string;
  requestedTakeId?: string;
  principal: Principal;
  participantName: unknown;
  deviceLabel: unknown;
  deviceId: unknown;
  isBuiltInMic: unknown;
  sessionStartedAt: unknown;
  syncMarker?: SyncMarkerMetadata;
}) {
  const {
    sessionId,
    requestedTrackId,
    requestedSegmentId,
    requestedTakeId,
    principal,
    participantName,
    deviceLabel,
    deviceId,
    isBuiltInMic,
    sessionStartedAt,
    syncMarker,
  } = input;
  const participantId = principalParticipantId(principal);
  // Prefer the take the client was actually recording for. A delayed start
  // must not attach its audio to whichever take happens to be active by the
  // time presign arrives (the host may have moved on to a newer take).
  let activeTake: { id: string } | null = null;
  if (requestedTakeId) {
    const requestedTake = await db.recordingTake.findUnique({
      where: { id: requestedTakeId },
      select: { id: true, sessionId: true },
    });
    if (!requestedTake) {
      throw new Error("TAKE_NOT_FOUND");
    }
    if (requestedTake.sessionId !== sessionId) {
      throw new Error("TAKE_SESSION_MISMATCH");
    }
    activeTake = { id: requestedTake.id };
  } else {
    activeTake = await findActiveTake(sessionId);
  }

  let track = activeTake
    ? await db.track.findFirst({
        where: {
          sessionId,
          takeId: activeTake.id,
          participantId,
        },
        orderBy: { createdAt: "asc" },
      })
    : null;

  if (!track) {
    const existingTrack = await db.track.findUnique({
      where: { id: requestedTrackId },
    });

    if (existingTrack) {
      if (existingTrack.sessionId !== sessionId) {
        throw new Error("TRACK_SESSION_MISMATCH");
      }
      track = existingTrack;
    }
  }

  if (!track) {
    if (!participantName || typeof participantName !== "string") {
      throw new Error("PARTICIPANT_NAME_REQUIRED");
    }

    const safeDeviceLabel =
      typeof deviceLabel === "string" && deviceLabel.length > 0
        ? deviceLabel
        : null;
    const safeDeviceId =
      typeof deviceId === "string" && deviceId.length > 0 ? deviceId : null;
    const safeIsBuiltInMic =
      typeof isBuiltInMic === "boolean" ? isBuiltInMic : false;
    const safeSessionStartedAt =
      typeof sessionStartedAt === "string" &&
      !Number.isNaN(Date.parse(sessionStartedAt))
        ? new Date(sessionStartedAt)
        : null;

    try {
      track = await db.track.create({
        data: {
          id: requestedTrackId,
          sessionId,
          takeId: activeTake?.id ?? null,
          participantName,
          participantId,
          s3Key: trackRecordingKey(sessionId, requestedTrackId),
          deviceLabel: safeDeviceLabel,
          deviceId: safeDeviceId,
          isBuiltInMic: safeIsBuiltInMic,
          sessionStartedAt: safeSessionStartedAt,
        },
      });
    } catch (error) {
      if (!activeTake || !isUniqueConstraintError(error)) {
        throw error;
      }
      track = await db.track.findFirst({
        where: {
          sessionId,
          takeId: activeTake.id,
          participantId,
        },
        orderBy: { createdAt: "asc" },
      });
      if (!track) throw error;
    }
  }

  let segment = await db.trackSegment.findUnique({
    where: { id: requestedSegmentId },
  });

  if (segment && segment.trackId !== track.id) {
    throw new Error("SEGMENT_TRACK_MISMATCH");
  }

  if (!segment) {
    // segmentIndex is allocated by counting under a [trackId, segmentIndex]
    // unique constraint, so concurrent starts for the same participant/take
    // can collide; the loser recounts and retries.
    const maxAttempts = 3;
    for (let attempt = 1; !segment; attempt++) {
      const segmentIndex = await db.trackSegment.count({
        where: { trackId: track.id },
      });
      try {
        segment = await db.trackSegment.create({
          data: {
            id: requestedSegmentId,
            trackId: track.id,
            segmentIndex,
            s3Prefix: trackSegmentPrefix(
              sessionId,
              track.id,
              requestedSegmentId,
            ),
            syncMarkerVersion: syncMarker?.version,
            syncMarkerOffsetMs: syncMarker?.offsetMs,
            syncMarkerDurationMs: syncMarker?.durationMs,
          },
        });
      } catch (error) {
        if (!isUniqueConstraintError(error) || attempt >= maxAttempts) {
          throw error;
        }
        // A duplicate request may have created this exact segment id rather
        // than just claiming the index — reuse it instead of retrying.
        const existing = await db.trackSegment.findUnique({
          where: { id: requestedSegmentId },
        });
        if (existing) {
          if (existing.trackId !== track.id) {
            throw new Error("SEGMENT_TRACK_MISMATCH");
          }
          segment = existing;
        }
      }
    }

    // A new recording attempt is starting on this logical track. If the track
    // already looked finished (or failed), finalize/downloads would keep
    // serving the previous recording as final while this segment is in
    // flight — pull it back to recording until completion resolves it. The
    // condition lives in the write so a completion that landed after our
    // track read still gets demoted.
    const demoted = await db.track.updateMany({
      where: { id: track.id, status: { in: ["complete", "failed"] } },
      data: { status: "recording" },
    });
    if (demoted.count > 0) {
      track = (await db.track.findUnique({ where: { id: track.id } })) ?? track;
    }
  }

  return { track, segment };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      sessionId,
      trackId,
      partNumber,
      participantName,
      deviceLabel,
      deviceId,
      isBuiltInMic,
      sessionStartedAt,
    } = body;
    const requestedTakeId = cleanNonEmptyString(body?.takeId) ?? undefined;

    if (!sessionId || !trackId || partNumber === undefined) {
      return NextResponse.json(
        { error: "sessionId, trackId, and partNumber are required" },
        { status: 400 }
      );
    }

    const requestRecordingToken =
      req.headers.get("x-cozytrack-recording-token") ?? undefined;
    const isRecordingStart = partNumber === 0 && !requestRecordingToken;

    let recordingToken: string | undefined;
    let logicalTrackId = trackId;
    let segmentId = cleanNonEmptyString(body?.segmentId) ?? trackId;
    if (isRecordingStart) {
      let syncMarker: SyncMarkerMetadata | undefined;
      try {
        syncMarker = cleanSyncMarker(body?.syncMarker);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "SYNC_MARKER_INVALID"
        ) {
          return NextResponse.json(
            { error: "syncMarker is invalid" },
            { status: 400 },
          );
        }
        throw error;
      }

      // Starting a recording still requires normal host/guest auth. The
      // returned recording token is scoped to this session+track so later
      // chunks can keep uploading if the login cookie expires mid-take.
      const principal = await resolvePrincipal(req, sessionId);
      if (!principal) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      }
      if (principal.kind === "guest" && principal.sessionId !== sessionId) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }

      const existingSession = await db.session.findUnique({
        where: { id: sessionId },
        select: { id: true, status: true },
      });

      if (!existingSession) {
        return NextResponse.json(
          { error: `Session ${sessionId} was not found` },
          { status: 404 }
        );
      }
      if (!isRecordingSession(existingSession)) {
        return NextResponse.json(
          { error: FINALIZED_SESSION_ERROR },
          { status: 409 },
        );
      }

      try {
        const { track, segment } = await ensureLogicalTrackAndSegment({
          sessionId,
          requestedTrackId: trackId,
          requestedSegmentId: segmentId,
          requestedTakeId,
          principal,
          participantName,
          deviceLabel,
          deviceId,
          isBuiltInMic,
          sessionStartedAt,
          syncMarker,
        });
        logicalTrackId = track.id;
        segmentId = segment.id;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "PARTICIPANT_NAME_REQUIRED"
        ) {
          return NextResponse.json(
            { error: "participantName is required to start an upload" },
            { status: 400 }
          );
        }
        if (
          error instanceof Error &&
          (error.message === "TRACK_SESSION_MISMATCH" ||
            error.message === "SEGMENT_TRACK_MISMATCH" ||
            error.message === "TAKE_SESSION_MISMATCH")
        ) {
          return NextResponse.json({ error: "forbidden" }, { status: 403 });
        }
        if (error instanceof Error && error.message === "TAKE_NOT_FOUND") {
          return NextResponse.json(
            { error: "Recording take not found" },
            { status: 404 }
          );
        }
        throw error;
      }

      recordingToken = await issueRecordingUploadToken(
        sessionId,
        logicalTrackId,
        segmentId,
      );
    } else {
      // Subsequent chunks and the final recording.webm upload accept either
      // the original principal cookie or the recording-scoped upload token.
      const principal = await resolvePrincipal(req, sessionId);
      if (principal?.kind === "guest" && principal.sessionId !== sessionId) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
      if (!principal) {
        const uploadPrincipal = await verifyRecordingUploadToken(
          requestRecordingToken,
          sessionId,
          trackId,
          segmentId,
        );
        if (!uploadPrincipal) {
          return NextResponse.json({ error: "unauthorized" }, { status: 401 });
        }
      }

      const existingSession = await db.session.findUnique({
        where: { id: sessionId },
        select: { id: true, status: true },
      });
      if (!existingSession) {
        return NextResponse.json(
          { error: `Session ${sessionId} was not found` },
          { status: 404 },
        );
      }
      if (!isRecordingSession(existingSession)) {
        return NextResponse.json(
          { error: FINALIZED_SESSION_ERROR },
          { status: 409 },
        );
      }

      // The S3 key below is built from caller-supplied ids, and the PUT
      // happens before /api/upload/complete validates anything — so the
      // segment must be proven to exist under the authenticated track before
      // any writable URL is issued.
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
        return NextResponse.json(
          { error: "Track segment not found" },
          { status: 404 }
        );
      }
      if (existingSegment.trackId !== trackId) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
    }

    const key =
      partNumber === 9999
        ? trackSegmentRecordingKey(sessionId, logicalTrackId, segmentId)
        : trackSegmentPartKey(sessionId, logicalTrackId, segmentId, partNumber);
    const url = await getPresignedPutUrl(key);

    return NextResponse.json({
      url,
      key,
      recordingToken,
      trackId: logicalTrackId,
      segmentId,
    });
  } catch (error) {
    console.error("Failed to generate presigned URL:", error);
    return NextResponse.json(
      { error: getUploadErrorMessage(error) },
      { status: 500 }
    );
  }
}
