-- Support logical participant continuity across reconnects during an active take.
ALTER TABLE "Session" ADD COLUMN "activeRecordingStartedAt" TIMESTAMP(3);

ALTER TABLE "Track" ADD COLUMN "participantIdentity" TEXT;
ALTER TABLE "Track" ADD COLUMN "segmentIndex" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "Track_sessionId_participantIdentity_sessionStartedAt_idx"
  ON "Track"("sessionId", "participantIdentity", "sessionStartedAt");
