import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isApiAuthorized } from "@/lib/api-auth";
import { recoverTrack, type RecoveryResult } from "@/lib/recovery";

// Tracks must be untouched for this long before the sweep treats them as
// orphaned. Inline recovery (in /finalize) acts immediately; this endpoint
// is the long-tail safety net for sessions that were never finalized.
const STALE_MS = 10 * 60 * 1000;
const MAX_TRACKS = 50;

export async function POST(req: NextRequest) {
  if (!isApiAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const cutoff = new Date(Date.now() - STALE_MS);

    const stuck = await db.track.findMany({
      where: {
        status: { not: "complete" },
        updatedAt: { lt: cutoff },
      },
      select: { id: true },
      orderBy: { updatedAt: "asc" },
      take: MAX_TRACKS,
    });

    const results: (RecoveryResult | { trackId: string; error: string })[] = [];
    for (const t of stuck) {
      try {
        results.push(await recoverTrack(t.id));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[admin recover] track=${t.id} failed:`, err);
        results.push({ trackId: t.id, error: message });
      }
    }

    return NextResponse.json({
      scanned: stuck.length,
      cutoff: cutoff.toISOString(),
      results,
    });
  } catch (error) {
    console.error("Failed to sweep orphaned tracks:", error);
    return NextResponse.json(
      { error: "Failed to sweep orphaned tracks" },
      { status: 500 }
    );
  }
}
