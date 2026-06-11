import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  principalParticipantId,
  resolvePrincipal,
  type Principal,
} from "@/lib/auth";

type RecordingTakeWithStatuses = {
  id: string;
  sessionId: string;
  startedAt: Date;
  stoppedAt: Date | null;
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
    select: { id: true },
  });
}

async function findActiveTake(
  sessionId: string,
): Promise<RecordingTakeWithStatuses | null> {
  return await db.recordingTake.findFirst({
    where: { sessionId, stoppedAt: null },
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

function isUniqueActiveTakeConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
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

      const existing = await findActiveTake(id);
      if (existing) {
        return NextResponse.json(serializeRecordingState(existing, true));
      }

      try {
        const created = await db.recordingTake.create({
          data: { sessionId: id, startedAt },
          include: { participantStatuses: true },
        });
        return NextResponse.json(serializeRecordingState(created, true));
      } catch (error) {
        if (isUniqueActiveTakeConflict(error)) {
          const current = await findActiveTake(id);
          return NextResponse.json(serializeRecordingState(current, Boolean(current)));
        }
        throw error;
      }
    }

    const current = await findActiveTake(id);
    if (!current) {
      return NextResponse.json(serializeRecordingState(null, false));
    }

    const stopped = await db.recordingTake.update({
      where: { id: current.id },
      data: { stoppedAt: new Date() },
      include: {
        participantStatuses: { orderBy: { participantName: "asc" } },
      },
    });
    return NextResponse.json(serializeRecordingState(stopped, false));
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
