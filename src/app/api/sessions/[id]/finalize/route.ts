import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { recoverTrack } from "@/lib/recovery";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const session = await db.session.findUnique({
      where: { id },
      include: {
        tracks: { orderBy: { createdAt: "asc" } },
      },
    });

    if (!session) {
      return NextResponse.json(
        { error: "Session not found" },
        { status: 404 }
      );
    }

    if (session.status !== "ready") {
      const stuck = session.tracks.filter((t) => t.status !== "complete");

      // Layer B (issue #56): before reporting pending tracks back to the
      // client, attempt server-side recovery of orphaned chunks. The 30s
      // gate skips chunk-stitching while other participants may still be
      // uploading; the cheap recording.webm-exists check always runs.
      for (const t of stuck) {
        try {
          await recoverTrack(t.id, { chunkStitchMinAgeMs: 30_000 });
        } catch (err) {
          console.error(`[finalize] recoverTrack failed for ${t.id}:`, err);
        }
      }

      const refreshed = stuck.length
        ? await db.track.findMany({
            where: { id: { in: stuck.map((t) => t.id) } },
            select: { id: true, participantName: true, status: true },
          })
        : [];

      const pending = refreshed
        .filter((t) => t.status !== "complete" && t.status !== "failed")
        .map((t) => ({
          trackId: t.id,
          participantName: t.participantName,
          status: t.status,
        }));

      if (pending.length > 0) {
        return NextResponse.json({ pending }, { status: 409 });
      }

      await db.session.updateMany({
        where: { id, status: "recording" },
        data: { status: "ready", finalizedAt: new Date() },
      });
    }

    const updated = await db.session.findUnique({
      where: { id },
      include: {
        tracks: { orderBy: { createdAt: "asc" } },
      },
    });

    if (!updated) {
      return NextResponse.json(
        { error: "Session not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(updated, { status: 200 });
  } catch (error) {
    console.error("Failed to finalize session:", error);
    return NextResponse.json(
      { error: "Failed to finalize session" },
      { status: 500 }
    );
  }
}
