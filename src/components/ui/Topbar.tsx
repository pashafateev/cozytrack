"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface TopbarProps {
  /** Optional session label shown next to the wordmark, e.g. the session name. */
  session?: string | null;
}

/**
 * Sticky top navigation. The wordmark is always a link home. The right-hand
 * chips highlight the active top-level route.
 */
export function Topbar({ session }: TopbarProps) {
  const pathname = usePathname() ?? "";

  const isStudio = pathname.startsWith("/studio");
  const isDashboard = pathname.startsWith("/dashboard") || pathname.startsWith("/session");

  const chip = (label: string, active: boolean, href: string) => (
    <Link
      key={label}
      href={href}
      className={[
        "text-xs font-medium font-sans capitalize rounded-[5px] px-3 py-1 border",
        active
          ? "border-[color:var(--border-hi)] bg-card text-text"
          : "border-transparent text-text-3 hover:bg-card hover:text-text-2",
      ].join(" ")}
    >
      {label}
    </Link>
  );

  return (
    <div
      className="h-[52px] sticky top-0 z-50 flex items-center gap-4 px-5 border-b"
      style={{
        background: "var(--surface)",
        borderBottomColor: "var(--border)",
      }}
    >
      <Link
        href="/"
        className="text-[15px] font-bold tracking-[-0.03em] text-text font-sans"
      >
        cozy<span style={{ color: "var(--amber)" }}>track</span>
      </Link>
      <div className="w-px h-4" style={{ background: "var(--border)" }} />
      {session && (
        <span className="text-[13px] font-medium text-text-2 truncate">{session}</span>
      )}
      <div className="ml-auto flex gap-2">
        {/* Studio is contextual — only meaningful when you're inside a specific session. */}
        {isStudio && chip("studio", true, pathname)}
        {chip("dashboard", isDashboard, "/dashboard")}
      </div>
    </div>
  );
}
