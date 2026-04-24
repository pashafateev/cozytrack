"use client";

/**
 * Button — the one button style used across Cozytrack.
 *
 * Variants map to their semantic intent, not a color. Use:
 *   - primary: the main action on a screen (amber CTA)
 *   - ghost:   secondary, low-visual-weight actions
 *   - subtle:  tertiary, card-colored filler
 *   - danger:  destructive or recording actions
 */

import { type ButtonHTMLAttributes, forwardRef } from "react";

type Variant = "primary" | "ghost" | "subtle" | "danger";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const sizeClasses: Record<Size, string> = {
  sm: "text-[12px] px-[10px] py-[4px]",
  md: "text-[13px] px-[14px] py-[6px]",
  lg: "text-[15px] px-[22px] py-[11px]",
};

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-amber text-bg border-amber hover:bg-amber-hi",
  ghost:
    "bg-transparent text-text-2 border-[color:var(--border-hi)] hover:bg-card hover:text-text",
  subtle:
    "bg-card text-text-2 border-[color:var(--border)] hover:bg-card-hi hover:text-text",
  danger:
    "bg-[rgba(232,80,80,0.12)] text-rec border-[rgba(232,80,80,0.25)] hover:bg-[rgba(232,80,80,0.2)]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "ghost", size = "md", className = "", disabled, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled}
      className={[
        "inline-flex items-center justify-center gap-1.5 font-sans font-medium rounded-[6px] border cursor-pointer",
        "disabled:opacity-40 disabled:cursor-not-allowed",
        sizeClasses[size],
        variantClasses[variant],
        className,
      ].join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
});
