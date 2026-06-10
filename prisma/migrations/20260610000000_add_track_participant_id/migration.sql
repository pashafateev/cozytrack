ALTER TABLE "Track" ADD COLUMN "participantId" TEXT;

CREATE INDEX "Track_sessionId_participantId_idx"
  ON "Track"("sessionId", "participantId");
