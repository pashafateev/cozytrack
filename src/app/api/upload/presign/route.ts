import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackPartKey, trackRecordingKey, getPresignedPutUrl } from "@/lib/s3";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { sessionId, trackId, partNumber, participantName, deviceLabel, deviceId, isBuiltInMic } = body;

    if (!sessionId || !trackId || partNumber === undefined) {
      return NextResponse.json(
        { error: "sessionId, trackId, and partNumber are required" },
        { status: 400 }
      );
    }

    if (partNumber === 0) {
      const existingTrack = await db.track.findUnique({
        where: { id: trackId },
        select: { id: true },
      });

      if (!existingTrack) {
        if (!participantName || typeof participantName !== "string") {
          return NextResponse.json(
            { error: "participantName is required to start an upload" },
            { status: 400 }
          );
        }

        await db.track.create({
          data: {
            id: trackId,
            sessionId,
            participantName,
            s3Key: trackRecordingKey(sessionId, trackId),
            deviceLabel: deviceLabel ?? null,
            deviceId: deviceId ?? null,
            isBuiltInMic: isBuiltInMic ?? false,
          },
        });
      }
    }

    const key =
      partNumber === 9999
        ? trackRecordingKey(sessionId, trackId)
        : trackPartKey(sessionId, trackId, partNumber);
    const url = await getPresignedPutUrl(key);

    return NextResponse.json({ url, key });
  } catch (error) {
    console.error("Failed to generate presigned URL:", error);
    return NextResponse.json(
      { error: "Failed to generate presigned URL" },
      { status: 500 }
    );
  }
}
