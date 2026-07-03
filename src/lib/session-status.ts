import type { Prisma } from "@prisma/client";

export const FINALIZED_SESSION_ERROR = "Session is already finalized";

export function isRecordingSession(session: { status: string }): boolean {
  return session.status === "recording";
}

type RecordingSessionWriteClient = Pick<Prisma.TransactionClient, "session">;

export type RecordingSessionWriteClaim =
  | { ok: true }
  | { ok: false; reason: "missing" | "finalized" };

export async function claimRecordingSessionForWrite(
  client: RecordingSessionWriteClient,
  sessionId: string,
): Promise<RecordingSessionWriteClaim> {
  // Rewriting the same status is intentional: inside a transaction this is a
  // conditional row claim that makes recording writes and finalize serialize.
  const claimed = await client.session.updateMany({
    where: { id: sessionId, status: "recording" },
    data: { status: "recording" },
  });
  if (claimed.count > 0) return { ok: true };

  const session = await client.session.findUnique({
    where: { id: sessionId },
    select: { id: true },
  });
  return session
    ? { ok: false, reason: "finalized" }
    : { ok: false, reason: "missing" };
}
