-- Attach logical tracks to recording takes and introduce internal physical segments.
ALTER TABLE "Track" ADD COLUMN "takeId" TEXT;

CREATE TABLE "TrackSegment" (
    "id" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "segmentIndex" INTEGER NOT NULL,
    "s3Prefix" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'recording',
    "durationMs" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackSegment_pkey" PRIMARY KEY ("id")
);

-- Existing recordings are single-segment logical tracks. Reuse the track id as
-- the default segment id so today's S3 keys remain valid.
INSERT INTO "TrackSegment" (
    "id",
    "trackId",
    "segmentIndex",
    "s3Prefix",
    "status",
    "durationMs",
    "startedAt",
    "completedAt",
    "createdAt",
    "updatedAt"
)
SELECT
    "id",
    "id",
    0,
    'sessions/' || "sessionId" || '/tracks/' || "id" || '/',
    "status",
    "durationMs",
    "createdAt",
    CASE WHEN "status" = 'complete' THEN "updatedAt" ELSE NULL END,
    "createdAt",
    "updatedAt"
FROM "Track";

CREATE UNIQUE INDEX "Track_takeId_participantId_key"
    ON "Track"("takeId", "participantId");

CREATE UNIQUE INDEX "TrackSegment_trackId_segmentIndex_key"
    ON "TrackSegment"("trackId", "segmentIndex");

CREATE INDEX "TrackSegment_trackId_status_idx"
    ON "TrackSegment"("trackId", "status");

ALTER TABLE "Track"
    ADD CONSTRAINT "Track_takeId_fkey"
    FOREIGN KEY ("takeId") REFERENCES "RecordingTake"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TrackSegment"
    ADD CONSTRAINT "TrackSegment_trackId_fkey"
    FOREIGN KEY ("trackId") REFERENCES "Track"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
