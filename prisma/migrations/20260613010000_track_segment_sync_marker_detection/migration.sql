ALTER TABLE "TrackSegment"
ADD COLUMN "syncMarkerDetectedAtMs" DOUBLE PRECISION,
ADD COLUMN "syncMarkerDetectedAtSamples" INTEGER,
ADD COLUMN "syncMarkerConfidence" DOUBLE PRECISION,
ADD COLUMN "syncMarkerDetectionStatus" TEXT,
ADD COLUMN "syncMarkerAnalyzedAt" TIMESTAMP(3);
