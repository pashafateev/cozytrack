import { NextRequest, NextResponse } from "next/server";
import { RoomServiceClient } from "livekit-server-sdk";
import { db } from "@/lib/db";
import { withSessionLock } from "@/lib/session-lock";
import {
  isLocalTrackSlotId,
  principalParticipantId,
  resolvePrincipal,
  type Principal,
} from "@/lib/auth";
import { recoverStoppedTakeTracks, recoverTrack } from "@/lib/recovery";

export const maxDuration = 300;

const DISCONNECTED_RECOVERY_CONFIRM_MS = 5_000;
const DISCONNECTED_RECOVERY_QUIET_MS = 30_000;
const DISCONNECTED_RECOVERY_POLL_MS = 1_000;
const DISCONNECTED_RECOVERY_TIMEOUT_MS = 45_000;
const LIVEKIT_REQUEST_TIMEOUT_SECONDS = 5;

type RecordingTakeWithStatuses = {
  id: string;
  sessionId: string;
  startedAt: Date;
  stoppedAt: Date | null;
  status: string;
  participantStatuses?: Array<{
    participantId: string;
    participantName: string | null;
    readinessStatus: string | null;
    recordingStatus: string | null;
    statusReason: string | null;
    updatedAt: Date;
  }>;
};

const READINESS_STATUSES = new Set(["ready", "not_ready"]);
const RECORDING_STATUSES = new Set([
  "connected",
  "recording",
  "finalizing",
  "complete",
  "failed",
]);

function parseStartedAt(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed);
}

function parseOptionalStatus(
  value: unknown,
  allowed: Set<string>,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string" && allowed.has(value)) return value;
  return "__invalid__";
}

function cleanReason(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 240) : null;
}

function participantNameFor(principal: Principal, value: unknown): string | null {
  if (principal.kind === "guest") return principal.name;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 80) : null;
}

async function requirePrincipal(req: NextRequest, sessionId: string) {
  const principal = await resolvePrincipal(req, sessionId);
  if (!principal) return { error: "unauthorized", status: 401 } as const;
  if (principal.kind === "guest" && principal.sessionId !== sessionId) {
    return { error: "forbidden", status: 403 } as const;
  }
  return { principal } as const;
}

async function requireSession(sessionId: string) {
  return await db.session.findUnique({
    where: { id: sessionId },
    select: { id: true, status: true },
  });
}

// "Active" is now authoritative on status, not on stoppedAt IS NULL. A take is
// resumable/active only while its status is "recording".
async function findActiveTake(
  sessionId: string,
): Promise<RecordingTakeWithStatuses | null> {
  return await db.recordingTake.findFirst({
    where: { sessionId, status: "recording" },
    orderBy: { startedAt: "desc" },
    include: {
      participantStatuses: { orderBy: { participantName: "asc" } },
    },
  });
}

function serializeTake(take: RecordingTakeWithStatuses | null) {
  if (!take) return null;
  return {
    id: take.id,
    sessionId: take.sessionId,
    startedAt: take.startedAt.toISOString(),
    stoppedAt: take.stoppedAt?.toISOString() ?? null,
    status: take.status,
    participantStatuses: (take.participantStatuses ?? []).map((status) => ({
      participantId: status.participantId,
      participantName: status.participantName,
      readinessStatus: status.readinessStatus,
      recordingStatus: status.recordingStatus,
      statusReason: status.statusReason,
      updatedAt: status.updatedAt.toISOString(),
    })),
  };
}

function serializeRecordingState(
  take: RecordingTakeWithStatuses | null,
  active: boolean,
  recoveryPending = false,
) {
  return {
    active,
    sessionStartedAt: active ? take?.startedAt.toISOString() ?? null : null,
    take: serializeTake(take),
    ...(recoveryPending ? { recoveryPending: true } : {}),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function livekitClient(): RoomServiceClient {
  const livekitUrl = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!livekitUrl || !apiKey || !apiSecret) {
    throw new Error(
      "LiveKit credentials are required to recover disconnected recording tracks",
    );
  }
  return new RoomServiceClient(livekitUrl, apiKey, apiSecret, {
    requestTimeout: LIVEKIT_REQUEST_TIMEOUT_SECONDS,
  });
}

function isHostOwnedTrack(participantId: string): boolean {
  return participantId === "host" || isLocalTrackSlotId(participantId);
}

function participantJoinedAtMs(participant: {
  joinedAt: bigint;
  joinedAtMs: bigint;
}): number | null {
  const millisecondValue = Number(participant.joinedAtMs);
  if (Number.isFinite(millisecondValue) && millisecondValue > 0) {
    return millisecondValue;
  }
  const secondValue = Number(participant.joinedAt);
  return Number.isFinite(secondValue) && secondValue > 0
    ? secondValue * 1_000
    : null;
}

type UnfinishedGuestTrack = {
  id: string;
  participantId: string;
  recordingStatus: string | null;
};

async function unfinishedGuestTracks(
  takeId: string,
): Promise<UnfinishedGuestTrack[]> {
  const unfinishedTracks = await db.track.findMany({
    where: {
      takeId,
      status: { notIn: ["complete", "failed"] },
    },
    select: {
      id: true,
      participantId: true,
    },
  });
  const guestTracks = unfinishedTracks.flatMap((track) =>
    track.participantId && !isHostOwnedTrack(track.participantId)
      ? [{ id: track.id, participantId: track.participantId }]
      : [],
  );
  if (guestTracks.length === 0) return [];

  const statuses = await db.recordingTakeParticipantStatus.findMany({
    where: {
      takeId,
      participantId: {
        in: Array.from(
          new Set(guestTracks.map((track) => track.participantId)),
        ),
      },
    },
    select: {
      participantId: true,
      recordingStatus: true,
    },
  });
  const statusByParticipant = new Map(
    statuses.map((status) => [
      status.participantId,
      status.recordingStatus,
    ]),
  );
  return guestTracks.map((track) => ({
    ...track,
    recordingStatus: statusByParticipant.get(track.participantId) ?? null,
  }));
}

async function recoverDisconnectedTakeTracks(
  sessionId: string,
  takeId: string,
): Promise<boolean> {
  const deadline = Date.now() + DISCONNECTED_RECOVERY_TIMEOUT_MS;
  const candidates = new Set<string>();
  const absentSince = new Map<string, number>();
  const roomService = livekitClient();
  const take = await db.recordingTake.findUnique({
    where: { id: takeId },
    select: { stoppedAt: true },
  });
  if (!take?.stoppedAt) {
    throw new Error(`Stopped take ${takeId} has no stop timestamp`);
  }
  const stoppedAtMs = take.stoppedAt.getTime();
  let candidatesInitialized = false;

  while (Date.now() < deadline) {
    // Connected participants normally complete after the stop response lets
    // the host broadcast recording_stop. This also rematerializes any older
    // interrupted segment once a connected participant's latest segment wins.
    try {
      await recoverStoppedTakeTracks(takeId);
    } catch (error) {
      console.error(
        `[recording-state] take=${takeId} stopped-track recovery retry failed:`,
        error,
      );
    }

    const unfinishedTracks = await unfinishedGuestTracks(takeId);
    if (unfinishedTracks.length === 0) return false;

    let preStopConnectedParticipantIds: Set<string>;
    try {
      const participants = await roomService.listParticipants(sessionId);
      preStopConnectedParticipantIds = new Set(
        participants
          .filter((participant) => {
            const joinedAtMs = participantJoinedAtMs(participant);
            // The same stable guest identity can open a fresh, idle page after
            // the stop. Only a connection that predates (or is ambiguous with)
            // the durable stop can still own the old recorder.
            return (
              joinedAtMs === null ||
              joinedAtMs <= stoppedAtMs
            );
          })
          .map((participant) => participant.identity),
      );
    } catch (error) {
      console.error(
        `[recording-state] take=${takeId} failed to check LiveKit participants:`,
        error,
      );
      await delay(DISCONNECTED_RECOVERY_POLL_MS);
      continue;
    }

    const now = Date.now();
    if (!candidatesInitialized) {
      // Freeze the recovery set on the first authoritative LiveKit snapshot.
      // A guest already absent while the stop response is being retried could
      // not receive the subsequent recording_stop broadcast. Never add a
      // participant that was initially connected: they may be finalizing a
      // direct S3 upload if they disconnect later.
      for (const track of unfinishedTracks) {
        if (
          track.recordingStatus === "recording" &&
          !preStopConnectedParticipantIds.has(track.participantId)
        ) {
          candidates.add(track.id);
          absentSince.set(track.id, now);
        }
      }
      candidatesInitialized = true;
    }

    const unfinishedById = new Map(
      unfinishedTracks.map((track) => [track.id, track]),
    );
    for (const trackId of Array.from(candidates)) {
      const track = unfinishedById.get(trackId);
      if (!track) {
        candidates.delete(trackId);
        absentSince.delete(trackId);
        continue;
      }

      // `finalizing` is the server-visible guard for a final recording.webm
      // PUT. Fail closed on any other transition or missing status rather than
      // racing a client that may still own the upload.
      if (track.recordingStatus !== "recording") {
        candidates.delete(trackId);
        absentSince.delete(trackId);
        continue;
      }

      if (preStopConnectedParticipantIds.has(track.participantId)) {
        // A transient LiveKit disconnect can reconnect the original recorder.
        // Once it reappears, leave this track to the normal client/recovery
        // paths instead of treating a later absence as the original teardown.
        candidates.delete(trackId);
        absentSince.delete(trackId);
        continue;
      }

      const firstAbsentAt = absentSince.get(trackId) ?? now;
      absentSince.set(trackId, firstAbsentAt);
      if (now - firstAbsentAt < DISCONNECTED_RECOVERY_CONFIRM_MS) continue;

      try {
        await recoverTrack(trackId, {
          // LiveKit absence alone is not enough: a closing or reconnecting tab
          // may still have a direct S3 PUT in flight. Only stitch after chunk
          // activity has stayed quiet for the same conservative window used by
          // stopped-session recovery.
          chunkStitchMinAgeMs: DISCONNECTED_RECOVERY_QUIET_MS,
        });
      } catch (error) {
        console.error(
          `[recording-state] take=${takeId} failed to recover disconnected track ${trackId}:`,
          error,
        );
      }
    }

    await delay(DISCONNECTED_RECOVERY_POLL_MS);
  }

  console.error(
    `[recording-state] take=${takeId} disconnected-track recovery timed out`,
  );
  return true;
}

async function recoverStoppedTakeForResponse(
  sessionId: string,
  takeId: string | null,
  newlyStopped: boolean,
): Promise<boolean> {
  if (!takeId) return false;
  let recoveryPending = false;
  try {
    await recoverStoppedTakeTracks(takeId);
  } catch (error) {
    // The take transition is already committed. Media recovery can be retried
    // by later stopped-take/upload recovery paths, but it must not make the
    // host believe the authoritative stop failed and leave the room recording.
    console.error(
      `[recording-state] take=${takeId} stopped with media recovery pending:`,
      error,
    );
    recoveryPending = true;
  }

  let hasUnfinishedGuests = false;
  try {
    hasUnfinishedGuests = (await unfinishedGuestTracks(takeId)).length > 0;
  } catch (error) {
    console.error(
      `[recording-state] take=${takeId} failed to inspect disconnected tracks:`,
      error,
    );
    recoveryPending = true;
  }

  if (!hasUnfinishedGuests) return recoveryPending;

  // Return the durable stop promptly so the host can broadcast recording_stop.
  // `stopRecordingTake` already follows a recoveryPending response with an
  // idempotent retry; that awaited retry owns the bounded recovery poll. This
  // avoids acknowledging a best-effort post-response task and avoids enqueuing
  // overlapping pollers for repeated stop requests.
  if (newlyStopped) return true;

  try {
    recoveryPending =
      (await recoverDisconnectedTakeTracks(sessionId, takeId)) ||
      recoveryPending;
  } catch (error) {
    console.error(
      `[recording-state] take=${takeId} disconnected-track recovery failed:`,
      error,
    );
    recoveryPending = true;
  }
  return recoveryPending;
}

function serializeParticipantStatus(status: {
  takeId: string;
  participantId: string;
  participantName: string | null;
  readinessStatus: string | null;
  recordingStatus: string | null;
  statusReason: string | null;
  updatedAt: Date;
}) {
  return {
    takeId: status.takeId,
    participantId: status.participantId,
    participantName: status.participantName,
    readinessStatus: status.readinessStatus,
    recordingStatus: status.recordingStatus,
    statusReason: status.statusReason,
    updatedAt: status.updatedAt.toISOString(),
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const auth = await requirePrincipal(req, id);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const session = await requireSession(id);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const take = await findActiveTake(id);
    return NextResponse.json(serializeRecordingState(take, Boolean(take)));
  } catch (error) {
    console.error("Failed to read recording state:", error);
    return NextResponse.json(
      { error: "Failed to read recording state" },
      { status: 500 },
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const auth = await requirePrincipal(req, id);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }
    if (auth.principal.kind !== "host") {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const session = await requireSession(id);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const active = body?.active === true;

    if (active) {
      const startedAt = parseStartedAt(body?.sessionStartedAt);
      if (!startedAt) {
        return NextResponse.json(
          { error: "sessionStartedAt is required when active is true" },
          { status: 400 },
        );
      }

      // Re-read status and create the take under a per-session advisory lock so
      // a concurrent finalize cannot interleave between the status check and the
      // take creation (issue #151). Without the lock this is a check-then-create
      // race: finalize could flip the session to `ready` just after we read
      // `recording`, and we'd attach a new take to an already-ingested session.
      // Holding the lock also serializes competing starts, so the loser observes
      // the winner's take instead of colliding on the unique-active-take index.
      const outcome = await withSessionLock(id, async (tx) => {
        const fresh = await tx.session.findUnique({
          where: { id },
          select: { status: true },
        });
        if (!fresh) return { kind: "not_found" as const };
        if (fresh.status === "ready") return { kind: "finalized" as const };

        const existing = await tx.recordingTake.findFirst({
          where: { sessionId: id, status: "recording" },
          orderBy: { startedAt: "desc" },
          include: {
            participantStatuses: { orderBy: { participantName: "asc" } },
          },
        });
        if (existing) return { kind: "existing" as const, take: existing };

        const created = await tx.recordingTake.create({
          data: { sessionId: id, startedAt },
          include: { participantStatuses: true },
        });
        return { kind: "created" as const, take: created };
      });

      if (outcome.kind === "not_found") {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      if (outcome.kind === "finalized") {
        return NextResponse.json(
          {
            error:
              "This session is finalized and can no longer be recorded into. Start a new session.",
          },
          { status: 409 },
        );
      }
      return NextResponse.json(serializeRecordingState(outcome.take, true));
    }

    const requestedTakeId =
      typeof body?.takeId === "string" && body.takeId.length > 0
        ? body.takeId
        : null;

    if (requestedTakeId) {
      const outcome = await withSessionLock(id, async (tx) => {
        const target = await tx.recordingTake.findUnique({
          where: { id: requestedTakeId },
          include: {
            participantStatuses: { orderBy: { participantName: "asc" } },
          },
        });
        if (target && target.sessionId !== id) {
          return { kind: "forbidden" as const };
        }

        // Recovery stops only the take finalize reported. A delayed
        // confirmation must never stop a newer active take that appeared in
        // the meantime. Sharing the session advisory lock with initial presign
        // also prevents stop from landing between its take-status read and its
        // track/segment creation.
        const stopTransition =
          target?.status === "recording"
            ? await tx.recordingTake.updateMany({
                where: {
                  id: requestedTakeId,
                  sessionId: id,
                  status: "recording",
                },
                data: { stoppedAt: new Date(), status: "stopped" },
              })
            : { count: 0 };
        const newlyStopped = stopTransition.count > 0;

        const stoppedTarget = target
          ? await tx.recordingTake.findUnique({
              where: { id: requestedTakeId },
              include: {
                participantStatuses: { orderBy: { participantName: "asc" } },
              },
            })
          : null;
        const recoveryTakeId =
          stoppedTarget?.status === "stopped" ? stoppedTarget.id : null;

        const remainingActive = await tx.recordingTake.findFirst({
          where: { sessionId: id, status: "recording" },
          orderBy: { startedAt: "desc" },
          include: {
            participantStatuses: { orderBy: { participantName: "asc" } },
          },
        });
        if (remainingActive) {
          return {
            kind: "active" as const,
            take: remainingActive,
            recoveryTakeId,
            newlyStopped,
          };
        }

        return {
          kind: "inactive" as const,
          take: stoppedTarget,
          recoveryTakeId,
          newlyStopped,
        };
      });

      if (outcome.kind === "forbidden") {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
      const recoveryPending = await recoverStoppedTakeForResponse(
        id,
        outcome.recoveryTakeId,
        outcome.newlyStopped,
      );
      if (outcome.kind === "active") {
        return NextResponse.json(
          serializeRecordingState(outcome.take, true, recoveryPending),
        );
      }
      return NextResponse.json(
        serializeRecordingState(outcome.take, false, recoveryPending),
      );
    }

    // Serialize the legacy untargeted stop with starts, recovery stops, and
    // initial presigns. Otherwise a delayed presign can validate the active
    // take, lose the race to this stop, and create writable artifacts for a
    // take that is already stopped.
    const stopOutcome = await withSessionLock(id, async (tx) => {
      const current = await tx.recordingTake.findFirst({
        where: { sessionId: id, status: "recording" },
        orderBy: { startedAt: "desc" },
      });
      if (!current) {
        const recentStopped = await tx.recordingTake.findFirst({
          where: { sessionId: id, status: "stopped" },
          orderBy: { stoppedAt: "desc" },
        });
        return {
          stopped: null,
          recoveryTakeId: recentStopped?.id ?? null,
          newlyStopped: false,
        };
      }

      const stopped = await tx.recordingTake.update({
        where: { id: current.id },
        data: { stoppedAt: new Date(), status: "stopped" },
        include: {
          participantStatuses: { orderBy: { participantName: "asc" } },
        },
      });
      return { stopped, recoveryTakeId: stopped.id, newlyStopped: true };
    });
    const recoveryPending = await recoverStoppedTakeForResponse(
      id,
      stopOutcome.recoveryTakeId,
      stopOutcome.newlyStopped,
    );

    // Keep the existing idempotent behavior: if there's no active take
    // (already stopped, or a retry after the first stop landed), report
    // inactive so a retrying client converges.
    if (!stopOutcome.stopped) {
      return NextResponse.json(
        serializeRecordingState(null, false, recoveryPending),
      );
    }
    return NextResponse.json(
      serializeRecordingState(stopOutcome.stopped, false, recoveryPending),
    );
  } catch (error) {
    console.error("Failed to update recording state:", error);
    return NextResponse.json(
      { error: "Failed to update recording state" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const auth = await requirePrincipal(req, id);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const body = await req.json().catch(() => ({}));
    const readinessStatus = parseOptionalStatus(
      body?.readinessStatus,
      READINESS_STATUSES,
    );
    if (readinessStatus === "__invalid__") {
      return NextResponse.json(
        { error: "readinessStatus must be ready or not_ready" },
        { status: 400 },
      );
    }

    const recordingStatus = parseOptionalStatus(
      body?.recordingStatus,
      RECORDING_STATUSES,
    );
    if (recordingStatus === "__invalid__") {
      return NextResponse.json(
        {
          error:
            "recordingStatus must be connected, recording, finalizing, complete, or failed",
        },
        { status: 400 },
      );
    }

    const statusReason = cleanReason(body?.reason);
    if (
      readinessStatus === undefined &&
      recordingStatus === undefined &&
      statusReason === undefined
    ) {
      return NextResponse.json(
        { error: "At least one participant status field is required" },
        { status: 400 },
      );
    }

    const requestedTakeId = typeof body?.takeId === "string" ? body.takeId : null;
    const take = requestedTakeId
      ? await db.recordingTake.findUnique({
          where: { id: requestedTakeId },
          include: { participantStatuses: true },
        })
      : await findActiveTake(id);

    if (!take) {
      return NextResponse.json(
        { error: "Recording take not found" },
        { status: 404 },
      );
    }
    if (take.sessionId !== id) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const participantId = principalParticipantId(auth.principal);
    const participantName = participantNameFor(
      auth.principal,
      body?.participantName,
    );
    const update = {
      participantName,
      ...(readinessStatus !== undefined ? { readinessStatus } : {}),
      ...(recordingStatus !== undefined ? { recordingStatus } : {}),
      ...(statusReason !== undefined ? { statusReason } : {}),
    };

    const status = await db.recordingTakeParticipantStatus.upsert({
      where: {
        takeId_participantId: {
          takeId: take.id,
          participantId,
        },
      },
      create: {
        takeId: take.id,
        participantId,
        participantName,
        readinessStatus: readinessStatus ?? null,
        recordingStatus: recordingStatus ?? null,
        statusReason: statusReason ?? null,
      },
      update,
    });

    return NextResponse.json({
      participantStatus: serializeParticipantStatus(status),
    });
  } catch (error) {
    console.error("Failed to report recording participant status:", error);
    return NextResponse.json(
      { error: "Failed to report recording participant status" },
      { status: 500 },
    );
  }
}
