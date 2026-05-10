import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isApiAuthorized } from "@/lib/api-auth";
import { recoverTrack, type RecoveryResult } from "@/lib/recovery";

// The chunk-stitch gate. Recovery only stitches when the newest chunk has
// been quiet for at least this long; protects active long-running recordings
// (Track.updatedAt does not reflect chunk activity, see issue #56 review).
const ACTIVITY_QUIET_MS = 10 * 60 * 1000;
// Coarse DB pre-filter to avoid scanning brand-new tracks. The real staleness
// signal is the S3 LastModified check inside recoverTrack.
const DB_PREFILTER_MS = 60 * 1000;
const MAX_TRACKS = 50;

export async function POST(req: NextRequest) {
  if (!isApiAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const cutoff = new Date(Date.now() - DB_PREFILTER_MS);

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
        results.push(
          await recoverTrack(t.id, {
            chunkStitchMinAgeMs: ACTIVITY_QUIET_MS,
          })
        );
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
