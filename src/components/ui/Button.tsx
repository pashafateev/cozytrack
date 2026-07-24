"use client";

/**
 * Button — the one button style used across Cozytrack.
 *
 * Variants map to their semantic intent, not a color. Use:
 *   - primary: the main action on a screen (solid accent, dark ink text)
 *   - ghost:   secondary, low-visual-weight actions
 *   - subtle:  tertiary, card-colored filler
 *   - danger:  destructive or recording actions
 *
 * The Sunset gradient is reserved for record affordances (REC / Finish) and
 * is deliberately NOT a Button variant — apply it at the call site.
 *
 * For link-styled buttons, use <ButtonLink> — it renders <a> (via next/link
 * under the hood) with the exact same classes, which avoids the invalid
 * <a><button/></a> nesting pattern.
 */

import {
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  forwardRef,
} from "react";
import Link, { type LinkProps } from "next/link";

type Variant = "primary" | "ghost" | "subtle" | "danger";
type Size = "sm" | "md" | "lg";

// Radius steps with size per the Sunset spec: chips/buttons 8, large CTAs 10.
const sizeClasses: Record<Size, string> = {
  sm: "text-[12px] px-[10px] py-[4px] rounded-[8px]",
  md: "text-[13px] px-[14px] py-[6px] rounded-[8px]",
  lg: "text-[15px] px-[22px] py-[11px] rounded-[10px]",
};

const variantClasses: Record<Variant, string> = {
  primary: "bg-accent text-accent-ink font-semibold border-accent hover:bg-accent-hi hover:border-accent-hi",
  ghost:
    "bg-transparent text-text-2 border-[color:var(--border-hi)] hover:bg-card hover:text-text",
  subtle:
    "bg-card text-text-2 border-[color:var(--border)] hover:bg-card-hi hover:text-text",
  danger:
    "bg-[rgba(255,59,77,0.12)] text-rec border-[rgba(255,59,77,0.25)] hover:bg-[rgba(255,59,77,0.2)]",
};

function classes(variant: Variant, size: Size, extra = ""): string {
  return [
    "inline-flex items-center justify-center gap-1.5 font-sans font-medium border cursor-pointer no-underline",
    "disabled:opacity-40 disabled:cursor-not-allowed",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] focus-visible:ring-offset-0",
    sizeClasses[size],
    variantClasses[variant],
    extra,
  ].join(" ");
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "ghost", size = "md", className = "", disabled, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled}
      className={classes(variant, size, className)}
      {...rest}
    >
      {children}
    </button>
  );
});

type ButtonLinkProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  keyof LinkProps
> &
  LinkProps & {
    variant?: Variant;
    size?: Size;
  };

/**
 * Link-styled button — renders <a> via next/link so we never nest
 * <button> inside <a>. Same visual styles as <Button>.
 */
export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(
  function ButtonLink(
    { variant = "ghost", size = "md", className = "", children, ...rest },
    ref,
  ) {
    return (
      <Link ref={ref} className={classes(variant, size, className)} {...rest}>
        {children}
      </Link>
    );
  },
);
