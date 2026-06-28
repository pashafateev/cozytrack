ALTER TABLE "TrackSegment"
DROP COLUMN IF EXISTS "syncMarkerVersion",
DROP COLUMN IF EXISTS "syncMarkerOffsetMs",
DROP COLUMN IF EXISTS "syncMarkerDurationMs",
DROP COLUMN IF EXISTS "syncMarkerDetectedAtMs",
DROP COLUMN IF EXISTS "syncMarkerDetectedAtSamples",
DROP COLUMN IF EXISTS "syncMarkerConfidence",
DROP COLUMN IF EXISTS "syncMarkerDetectionStatus",
DROP COLUMN IF EXISTS "syncMarkerAnalyzedAt";
