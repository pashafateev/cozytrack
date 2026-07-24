import Link from "next/link";

/**
 * Gradient "cozytrack" wordmark — the Sunset brand mark.
 *
 * The pink→amber gradient is part of the reserved record-affordance family,
 * deliberately echoed here (and nowhere else on plain surfaces).
 */
export function Wordmark({
  size = 16,
  href = "/",
  className = "",
}: {
  /** Font size in px. Weight is always 800. */
  size?: number;
  /** Set to null to render a plain <span> instead of a link. */
  href?: string | null;
  className?: string;
}) {
  const mark = (
    <span
      className={`wordmark-gradient font-extrabold tracking-[0.01em] font-sans ${className}`}
      style={{ fontSize: size }}
    >
      cozytrack
    </span>
  );
  if (href === null) return mark;
  return (
    <Link href={href} className="no-underline">
      {mark}
    </Link>
  );
}
