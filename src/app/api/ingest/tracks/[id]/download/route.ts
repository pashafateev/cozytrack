import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getPresignedGetUrl } from "@/lib/s3";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const track = await db.track.findUnique({
      where: { id },
    });

    if (!track) {
      return NextResponse.json(
        { error: "Track not found" },
        { status: 404 }
      );
    }

    if (track.s3PurgedAt) {
      return NextResponse.json(
        { error: "Track recording has been purged" },
        { status: 410 }
      );
    }

    if (!track.s3Key) {
      return NextResponse.json(
        { error: "Track recording not available" },
        { status: 404 }
      );
    }

    const url = await getPresignedGetUrl(track.s3Key);

    return NextResponse.json({ url });
  } catch (error) {
    console.error("Failed to generate download URL:", error);
    return NextResponse.json(
      { error: "Failed to generate download URL" },
      { status: 500 }
    );
  }
}
