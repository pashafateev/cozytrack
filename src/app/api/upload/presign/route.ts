import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackPartKey, trackRecordingKey, getPresignedPutUrl } from "@/lib/s3";

function getUploadErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Failed to generate presigned URL";
  }

  if (
    error.name === "CredentialsProviderError" ||
    error.message.includes("session has expired")
  ) {
    return "AWS session expired. Reauthenticate with `aws login` and try again.";
  }

  return "Failed to generate presigned URL";
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { sessionId, trackId, partNumber, participantName } = body;

    if (!sessionId || !trackId || partNumber === undefined) {
      return NextResponse.json(
        { error: "sessionId, trackId, and partNumber are required" },
        { status: 400 }
      );
    }

    if (partNumber === 0) {
      const existingSession = await db.session.findUnique({
        where: { id: sessionId },
        select: { id: true },
      });

      if (!existingSession) {
        return NextResponse.json(
          { error: `Session ${sessionId} was not found` },
          { status: 404 }
        );
      }

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
      { error: getUploadErrorMessage(error) },
      { status: 500 }
    );
  }
}
