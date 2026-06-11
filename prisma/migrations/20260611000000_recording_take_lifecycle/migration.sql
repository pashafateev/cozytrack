-- Represent host-controlled room recording state as a first-class take.
CREATE TABLE "RecordingTake" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "stoppedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecordingTake_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecordingTakeParticipantStatus" (
    "id" TEXT NOT NULL,
    "takeId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "participantName" TEXT,
    "readinessStatus" TEXT,
    "recordingStatus" TEXT,
    "statusReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecordingTakeParticipantStatus_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RecordingTake_sessionId_stoppedAt_idx"
    ON "RecordingTake"("sessionId", "stoppedAt");

CREATE UNIQUE INDEX "RecordingTake_sessionId_active_unique"
    ON "RecordingTake"("sessionId")
    WHERE "stoppedAt" IS NULL;

CREATE UNIQUE INDEX "RecordingTakeParticipantStatus_takeId_participantId_key"
    ON "RecordingTakeParticipantStatus"("takeId", "participantId");

CREATE INDEX "RecordingTakeParticipantStatus_participantId_idx"
    ON "RecordingTakeParticipantStatus"("participantId");

ALTER TABLE "RecordingTake"
    ADD CONSTRAINT "RecordingTake_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "Session"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecordingTakeParticipantStatus"
    ADD CONSTRAINT "RecordingTakeParticipantStatus_takeId_fkey"
    FOREIGN KEY ("takeId") REFERENCES "RecordingTake"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
