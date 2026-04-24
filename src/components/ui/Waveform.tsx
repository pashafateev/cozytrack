/**
 * Waveform — placeholder visualization for a recorded track.
 *
 * This renders a deterministic, seeded pattern that LOOKS like a waveform but
 * is not derived from real audio data. Real extraction + playback is tracked
 * in cozytrack#24.
 */

type WaveformProps = {
  /** Stable seed so the same track always looks the same between renders. */
  seed?: number;
  height?: number;
  /** 0..1 — portion of the waveform that should render in the "played" color. */
  played?: number;
  className?: string;
};

export function Waveform({ seed = 0, height = 28, played = 0, className }: WaveformProps) {
  const bars = 80;
  // Deterministic pseudo-random — enough entropy to look natural without a PRNG lib.
  const seededRandom = (n: number) =>
    Math.abs(Math.sin(n * 127.1 + seed * 311.7) * 43758.5) % 1;

  return (
    <div className={className} style={{ width: "100%", height, position: "relative" }}>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${bars * 3} ${height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {Array.from({ length: bars }).map((_, i) => {
          const amp =
            (seededRandom(i) * 0.7 + Math.abs(Math.sin(i * 0.18)) * 0.3) *
            (height * 0.85);
          const y = (height - amp) / 2;
          const isPlayed = i / bars < played;
          return (
            <rect
              key={i}
              x={i * 3}
              y={y}
              width={2}
              height={Math.max(2, amp)}
              rx={1}
              fill={isPlayed ? "var(--amber)" : "rgba(255,240,210,0.2)"}
            />
          );
        })}
      </svg>
    </div>
  );
}
