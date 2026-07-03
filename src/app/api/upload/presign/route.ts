import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { withSessionLock } from "@/lib/session-lock";
import {
  trackRecordingKey,
  trackSegmentPartKey,
  trackSegmentPrefix,
  trackSegmentRecordingKey,
  getPresignedPutUrl,
} from "@/lib/s3";
import {
  issueRecordingUploadToken,
  isLocalTrackSlotId,
  localTrackSlotParticipantId,
  principalParticipantId,
  resolvePrincipal,
  type Principal,
  verifyRecordingUploadToken,
} from "@/lib/auth";

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

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

async function findActiveTake(
  client: Prisma.TransactionClient,
  sessionId: string,
): Promise<{ id: string } | null> {
  return await client.recordingTake.findFirst({
    where: { sessionId, status: "recording" },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
}

// All reads/writes run through the caller-supplied transaction client so this
// executes inside the per-session advisory lock (issue #151): the session's
// `ready` status is re-checked and the track/segment are created atomically
// with respect to a concurrent finalize.
async function ensureLogicalTrackAndSegment(input: {
  client: Prisma.TransactionClient;
  sessionId: string;
  requestedTrackId: string;
  requestedSegmentId: string;
  requestedTakeId?: string;
  localTrackSlotId?: string;
  principal: Principal;
  participantName: unknown;
  deviceLabel: unknown;
  deviceId: unknown;
  isBuiltInMic: unknown;
  sessionStartedAt: unknown;
}) {
  const {
    client,
    sessionId,
    requestedTrackId,
    requestedSegmentId,
    requestedTakeId,
    localTrackSlotId,
    principal,
    participantName,
    deviceLabel,
    deviceId,
    isBuiltInMic,
    sessionStartedAt,
  } = input;
  // Local channel slots are host-owned. A guest must never be able to write
  // into a synthetic host participant id, so reject the slot before deriving
  // anything from it; an unknown slot id is a client bug, not an auth failure.
  let participantId: string;
  if (localTrackSlotId !== undefined) {
    if (principal.kind !== "host") {
      throw new Error("LOCAL_SLOT_FORBIDDEN");
    }
    if (!isLocalTrackSlotId(localTrackSlotId)) {
      throw new Error("LOCAL_SLOT_INVALID");
    }
    participantId = localTrackSlotParticipantId(localTrackSlotId);
  } else {
    participantId = principalParticipantId(principal);
  }
  // Prefer the take the client was actually recording for. A delayed start
  // must not attach its audio to whichever take happens to be active by the
  // time presign arrives (the host may have moved on to a newer take).
  let activeTake: { id: string } | null = null;
  if (requestedTakeId) {
    const requestedTake = await client.recordingTake.findUnique({
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
    activeTake = await findActiveTake(client, sessionId);
  }

  let track = activeTake
    ? await client.track.findFirst({
        where: {
          sessionId,
          takeId: activeTake.id,
          participantId,
        },
        orderBy: { createdAt: "asc" },
      })
    : null;

  if (!track) {
    const existingTrack = await client.track.findUnique({
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
      track = await client.track.create({
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
      track = await client.track.findFirst({
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

  let segment = await client.trackSegment.findUnique({
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
      const segmentIndex = await client.trackSegment.count({
        where: { trackId: track.id },
      });
      try {
        segment = await client.trackSegment.create({
          data: {
            id: requestedSegmentId,
            trackId: track.id,
            segmentIndex,
            s3Prefix: trackSegmentPrefix(
              sessionId,
              track.id,
              requestedSegmentId,
            ),
          },
        });
      } catch (error) {
        if (!isUniqueConstraintError(error) || attempt >= maxAttempts) {
          throw error;
        }
        // A duplicate request may have created this exact segment id rather
        // than just claiming the index — reuse it instead of retrying.
        const existing = await client.trackSegment.findUnique({
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
    const demoted = await client.track.updateMany({
      where: { id: track.id, status: { in: ["complete", "failed"] } },
      data: { status: "recording" },
    });
    if (demoted.count > 0) {
      track =
        (await client.track.findUnique({ where: { id: track.id } })) ?? track;
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
    const localTrackSlotId =
      cleanNonEmptyString(body?.localTrackSlotId) ?? undefined;

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

      // Refuse to start a brand-new recording (new track/segment) on a
      // finalized session. Its id has already been handed to ingest, so
      // any audio recorded here would attach to an old, already-ingested
      // session and never make it downstream (issue #151). Late chunk/final
      // uploads for tracks that started before finalize take the non-start
      // path below and are unaffected. This is a cheap early-out for the
      // common already-finalized case; the authoritative check runs under the
      // advisory lock below so a concurrent finalize can't slip in between.
      if (existingSession.status === "ready") {
        return NextResponse.json(
          {
            error:
              "This session is finalized and can no longer be recorded into. Start a new session.",
          },
          { status: 409 }
        );
      }

      try {
        // Re-check status and materialize the track/segment under a per-session
        // advisory lock so a finalize that flips the session to `ready` cannot
        // interleave between the status read and the create (issue #151).
        const locked = await withSessionLock(sessionId, async (tx) => {
          const fresh = await tx.session.findUnique({
            where: { id: sessionId },
            select: { status: true },
          });
          if (!fresh) return { kind: "not_found" as const };
          if (fresh.status === "ready") return { kind: "finalized" as const };

          const { track, segment } = await ensureLogicalTrackAndSegment({
            client: tx,
            sessionId,
            requestedTrackId: trackId,
            requestedSegmentId: segmentId,
            requestedTakeId,
            localTrackSlotId,
            principal,
            participantName,
            deviceLabel,
            deviceId,
            isBuiltInMic,
            sessionStartedAt,
          });
          return { kind: "ok" as const, track, segment };
        });

        if (locked.kind === "not_found") {
          return NextResponse.json(
            { error: `Session ${sessionId} was not found` },
            { status: 404 }
          );
        }
        if (locked.kind === "finalized") {
          return NextResponse.json(
            {
              error:
                "This session is finalized and can no longer be recorded into. Start a new session.",
            },
            { status: 409 }
          );
        }
        logicalTrackId = locked.track.id;
        segmentId = locked.segment.id;
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
        if (error instanceof Error && error.message === "LOCAL_SLOT_INVALID") {
          return NextResponse.json(
            { error: "Unknown local track slot" },
            { status: 400 }
          );
        }
        if (error instanceof Error && error.message === "LOCAL_SLOT_FORBIDDEN") {
          return NextResponse.json({ error: "forbidden" }, { status: 403 });
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
