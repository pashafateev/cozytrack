/**
 * Lucide-style stroked SVG icons used throughout Cozytrack.
 *
 * Centralized here so we don't pull in a full icon library and so every
 * icon inherits the same stroke weight and rounding defaults.
 */

type IconProps = {
  size?: number;
  color?: string;
  strokeWidth?: number;
  fill?: string;
  className?: string;
};

type PathsProps = IconProps & {
  d: string | string[];
};

function Paths({ d, size = 16, color = "currentColor", strokeWidth = 1.5, fill = "none", className }: PathsProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {Array.isArray(d) ? d.map((path, i) => <path key={i} d={path} />) : <path d={d} />}
    </svg>
  );
}

export const IcoMic = (p: IconProps) => (
  <Paths
    {...p}
    d={[
      "M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z",
      "M19 10v2a7 7 0 0 1-14 0v-2",
      "M12 19v3",
      "M8 22h8",
    ]}
  />
);

export const IcoLink = (p: IconProps) => (
  <Paths
    {...p}
    d={[
      "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
      "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
    ]}
  />
);

export const IcoDownload = (p: IconProps) => (
  <Paths
    {...p}
    d={[
      "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",
      "M7 10l5 5 5-5",
      "M12 15V3",
    ]}
  />
);

export const IcoPlay = (p: IconProps) => <Paths {...p} fill={p.fill ?? "currentColor"} d="M5 3l14 9-14 9V3z" />;
export const IcoPause = (p: IconProps) => <Paths {...p} d={["M6 4h4v16H6z", "M14 4h4v16h-4z"]} />;
export const IcoChevron = (p: IconProps) => <Paths {...p} d="M15 18l-6-6 6-6" />;
export const IcoPlus = (p: IconProps) => <Paths {...p} d={["M12 5v14", "M5 12h14"]} />;

export const IcoAlert = (p: IconProps) => (
  <Paths
    {...p}
    d={[
      "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z",
      "M12 9v4",
      "M12 17h.01",
    ]}
  />
);
