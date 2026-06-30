-- Make the take lifecycle authoritative: "recording" while in progress,
-- "stopped" once terminally stopped. Previously "active" was inferred from
-- stoppedAt IS NULL, which conflated "recording in progress" with "no stop
-- write has landed yet". status removes that ambiguity.
ALTER TABLE "RecordingTake"
    ADD COLUMN "status" TEXT NOT NULL DEFAULT 'recording';

-- Backfill: any take that already has a stop timestamp is terminally stopped.
UPDATE "RecordingTake"
    SET "status" = 'stopped'
    WHERE "stoppedAt" IS NOT NULL;

-- Re-key the one-active-take-per-session guard on status instead of stoppedAt.
DROP INDEX "RecordingTake_sessionId_active_unique";

CREATE UNIQUE INDEX "RecordingTake_sessionId_active_unique"
    ON "RecordingTake"("sessionId")
    WHERE "status" = 'recording';

CREATE INDEX "RecordingTake_sessionId_status_idx"
    ON "RecordingTake"("sessionId", "status");
