export const SYNC_MARKER_VERSION = "chirp-v1";
export const SYNC_MARKER_OFFSET_MS = 100;
export const SYNC_MARKER_DURATION_MS = 300;
export const SYNC_MARKER_START_FREQUENCY_HZ = 1200;
export const SYNC_MARKER_END_FREQUENCY_HZ = 3200;
export const SYNC_MARKER_GAIN = 0.12;

export type SyncMarkerMetadata = {
  version: typeof SYNC_MARKER_VERSION;
  offsetMs: typeof SYNC_MARKER_OFFSET_MS;
  durationMs: typeof SYNC_MARKER_DURATION_MS;
};

export function syncMarkerMetadata(): SyncMarkerMetadata {
  return {
    version: SYNC_MARKER_VERSION,
    offsetMs: SYNC_MARKER_OFFSET_MS,
    durationMs: SYNC_MARKER_DURATION_MS,
  };
}
