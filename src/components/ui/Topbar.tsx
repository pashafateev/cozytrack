"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Wordmark } from "@/components/ui/Wordmark";

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
        "text-xs font-medium font-sans rounded-[6px] px-3 py-1 border",
        active
          ? "border-[color:var(--border-hi)] bg-card text-text-2"
          : "border-transparent text-text-2 hover:bg-card hover:text-text",
      ].join(" ")}
    >
      {label}
    </Link>
  );

  return (
    <div
      className="h-[var(--topbar-height)] sticky top-0 z-50 flex items-center gap-3.5 px-[18px] border-b"
      style={{
        background: "var(--surface)",
        borderBottomColor: "var(--border)",
      }}
    >
      <Wordmark size={16} />
      {session && (
        <span className="text-[13px] text-text-2 truncate">· {session}</span>
      )}
      <div className="ml-auto flex gap-2 items-center">
        {/* Studio is contextual — only meaningful when you're inside a specific session. */}
        {isStudio && chip("studio", true, pathname)}
        {chip("dashboard", isDashboard, "/dashboard")}
        {/* Sign-out is POST to avoid accidental logouts from prefetchers */}
        <form action="/api/auth/signout" method="post" className="ml-2">
          <button
            type="submit"
            className="text-xs font-medium text-text-3 hover:text-text-2 bg-transparent border-0 cursor-pointer p-0"
            title="Sign out"
          >
            sign out
          </button>
        </form>
      </div>
    </div>
  );
}
