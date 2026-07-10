import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

// Namespace for cozytrack session advisory locks. Postgres advisory locks share
// a single global keyspace, so we partition ours under a fixed namespace int to
// avoid colliding with any other pg_advisory lock user in the same database.
// (0x021511 = "issue 151" mnemonic; any stable int4 works.)
const SESSION_LOCK_NAMESPACE = 0x021511;

/**
 * Run `fn` while holding a transaction-scoped advisory lock keyed by
 * `sessionId`, serializing it against any other `withSessionLock` call for the
 * same session.
 *
 * We use `pg_advisory_xact_lock` (not the session-level variant) deliberately:
 * runtime traffic runs through PgBouncer in transaction pooling mode, where a
 * connection is only ours for the duration of a transaction, so a session-level
 * advisory lock would leak onto whichever request reuses the connection next. A
 * transaction-scoped lock is acquired inside the interactive transaction and
 * released automatically on commit/rollback.
 *
 * This closes the check-then-create race (issue #151): the start guards
 * (recording-take + presign) and `finalize` all take this lock, so a finalize
 * that flips a session to `ready` cannot interleave between a start guard's
 * status read and its track/take creation.
 */
export async function withSessionLock<T>(
  sessionId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SESSION_LOCK_NAMESPACE}::int4, hashtext(${sessionId})::int4)`;
    return fn(tx);
  });
}
