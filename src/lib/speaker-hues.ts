/**
 * Speaker identity hues — Sunset design system.
 *
 * Each participant owns a hue, used consistently everywhere identity shows
 * up: wax tint, colored bubbles, lamp glow, avatars, and talking dots.
 * Beyond three participants the palette cycles (open question with design;
 * cycling is the agreed interim behavior).
 */

/** CSS hues for dots, avatars, and chip accents. */
export const SPEAKER_HUES = ["#ff4d7d", "#9a6bff", "#ffb347"] as const;

/** Wax-palette RGB triples used by the lava-lamp engine's speaker tint. */
export const SPEAKER_WAX_RGB: ReadonlyArray<readonly [number, number, number]> = [
  [255, 60, 130],
  [150, 100, 255],
  [255, 150, 60],
];

export function speakerHue(index: number): string {
  return SPEAKER_HUES[((index % SPEAKER_HUES.length) + SPEAKER_HUES.length) % SPEAKER_HUES.length];
}

export function speakerWaxRgb(index: number): readonly [number, number, number] {
  return SPEAKER_WAX_RGB[
    ((index % SPEAKER_WAX_RGB.length) + SPEAKER_WAX_RGB.length) % SPEAKER_WAX_RGB.length
  ];
}
