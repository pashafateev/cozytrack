import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withSessionLock } from "@/lib/session-lock";
import {
  principalParticipantId,
  resolvePrincipal,
  type Principal,
} from "@/lib/auth";
import { recoverStoppedTakeTracks } from "@/lib/recovery";

export const maxDuration = 300;

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
) {
  return {
    active,
    sessionStartedAt: active ? take?.startedAt.toISOString() ?? null : null,
    take: serializeTake(take),
  };
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
        if (target?.status === "recording") {
          await tx.recordingTake.updateMany({
            where: { id: requestedTakeId, sessionId: id, status: "recording" },
            data: { stoppedAt: new Date(), status: "stopped" },
          });
        }

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
          };
        }

        return {
          kind: "inactive" as const,
          take: stoppedTarget,
          recoveryTakeId,
        };
      });

      if (outcome.kind === "forbidden") {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
      if (outcome.recoveryTakeId) {
        await recoverStoppedTakeTracks(outcome.recoveryTakeId);
      }
      if (outcome.kind === "active") {
        return NextResponse.json(
          serializeRecordingState(outcome.take, true),
        );
      }
      return NextResponse.json(
        serializeRecordingState(outcome.take, false),
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
        };
      }

      const stopped = await tx.recordingTake.update({
        where: { id: current.id },
        data: { stoppedAt: new Date(), status: "stopped" },
        include: {
          participantStatuses: { orderBy: { participantName: "asc" } },
        },
      });
      return { stopped, recoveryTakeId: stopped.id };
    });
    if (stopOutcome.recoveryTakeId) {
      await recoverStoppedTakeTracks(stopOutcome.recoveryTakeId);
    }

    // Keep the existing idempotent behavior: if there's no active take
    // (already stopped, or a retry after the first stop landed), report
    // inactive so a retrying client converges.
    if (!stopOutcome.stopped) {
      return NextResponse.json(serializeRecordingState(null, false));
    }
    return NextResponse.json(
      serializeRecordingState(stopOutcome.stopped, false),
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
