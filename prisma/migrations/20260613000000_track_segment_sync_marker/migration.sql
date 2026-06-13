ALTER TABLE "TrackSegment"
ADD COLUMN "syncMarkerVersion" TEXT,
ADD COLUMN "syncMarkerOffsetMs" INTEGER,
ADD COLUMN "syncMarkerDurationMs" INTEGER;
