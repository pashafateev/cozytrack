/**
 * Aurora — Sunset's ambient backdrop: two soft radial glows over the deep
 * indigo floor, optionally with a sparse starfield and the studio's hairline
 * inset frame. Replaces the retired conic grain overlay.
 *
 * Render as the first child of a `relative` container. Pointer-transparent.
 */

const GLOWS: Record<AuroraVariant, string> = {
  studio:
    "radial-gradient(560px 340px at 18% 16%, rgba(150,90,255,0.09), transparent 70%)," +
    "radial-gradient(640px 420px at 84% 80%, rgba(255,70,130,0.07), transparent 70%)",
  auth:
    "radial-gradient(560px 340px at 24% 20%, rgba(150,90,255,0.09), transparent 70%)," +
    "radial-gradient(620px 400px at 80% 82%, rgba(255,70,130,0.07), transparent 70%)",
  home:
    "radial-gradient(620px 480px at 50% 30%, rgba(150,90,255,0.10), transparent 70%)," +
    "radial-gradient(560px 420px at 78% 82%, rgba(255,70,130,0.07), transparent 70%)",
};

type AuroraVariant = "studio" | "auth" | "home";

const STARS: Array<[number, number, number, number]> = [
  [88, 84, 1.2, 0.3],
  [210, 180, 0.9, 0.22],
  [150, 420, 1.1, 0.25],
  [60, 560, 0.8, 0.18],
  [320, 70, 1, 0.26],
  [420, 540, 1.2, 0.2],
  [500, 120, 0.8, 0.24],
  [700, 80, 1.1, 0.3],
  [820, 200, 0.9, 0.22],
  [920, 120, 1.2, 0.28],
  [960, 420, 1, 0.22],
  [860, 540, 1.1, 0.25],
  [640, 580, 0.8, 0.18],
  [760, 470, 0.9, 0.2],
];

const STAR_CROSSES = [
  "M 130 250 h 8 M 134 246 v 8",
  "M 880 320 h 8 M 884 316 v 8",
  "M 560 60 h 8 M 564 56 v 8",
];

export function Aurora({
  variant = "studio",
  stars = false,
  frame = false,
}: {
  variant?: AuroraVariant;
  /** Sparse 1px star dots — studio rooms only. */
  stars?: boolean;
  /** Hairline inset frame that makes the room read as a deliberate space. */
  frame?: boolean;
}) {
  return (
    <>
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{ background: GLOWS[variant] }}
      />
      {stars && (
        <svg
          viewBox="0 0 1024 640"
          preserveAspectRatio="xMidYMid slice"
          className="absolute inset-0 w-full h-full pointer-events-none"
          aria-hidden="true"
        >
          <g fill="#cfc2ff">
            {STARS.map(([cx, cy, r, opacity], i) => (
              <circle key={i} cx={cx} cy={cy} r={r} opacity={opacity} />
            ))}
          </g>
          <g stroke="#cfc2ff" strokeWidth="1" fill="none" opacity="0.3">
            {STAR_CROSSES.map((d, i) => (
              <path key={i} d={d} />
            ))}
          </g>
        </svg>
      )}
      {frame && (
        <div
          aria-hidden
          className="absolute pointer-events-none rounded-[14px] border"
          style={{ inset: 16, borderColor: "rgba(210,190,255,0.07)" }}
        />
      )}
    </>
  );
}
