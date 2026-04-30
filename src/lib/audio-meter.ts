// Shared constants and helpers for the audio level meters.
//
// The local meter (Web Audio analyser, ~60Hz RAF) and the remote meter
// (RTCPeerConnection getStats(), ~10Hz polling) need to look identical to
// the eye, so they share the perceptual shaping curve, smoothing weights,
// and clip-detection thresholds defined here. Polling-rate-dependent values
// (e.g. how many frames to hold the clip indicator) stay at the call site.

/** Receiver-side audioLevel threshold for "clipping". -1 dBFS ≈ 10^(-1/20). */
export const CLIP_THRESHOLD = 0.891;

/** Consecutive frames at/over the threshold required to latch the clip flag. */
export const CLIP_MIN_FRAMES = 2;

/** Compander exponent applied before scaling to 0..255. */
export const SHAPING_EXPONENT = 0.6;

/** Exponential smoothing weights: smoothed = prev * PREV + target * TARGET. */
export const SMOOTHING_PREV_WEIGHT = 0.7;
export const SMOOTHING_TARGET_WEIGHT = 0.3;

/**
 * Map a raw 0..1 level to the shared 0..255 meter scale (compander curve).
 */
export function shapeLevel(audioLevel: number): number {
  const clamped = Math.max(0, Math.min(1, audioLevel));
  return Math.pow(clamped, SHAPING_EXPONENT) * 255;
}

/**
 * Apply the shared exponential smoothing step.
 */
export function smoothLevel(prev: number, target: number): number {
  return prev * SMOOTHING_PREV_WEIGHT + target * SMOOTHING_TARGET_WEIGHT;
}
