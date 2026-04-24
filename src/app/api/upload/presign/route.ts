import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { trackPartKey, trackRecordingKey, getPresignedPutUrl } from "@/lib/s3";
import { resolvePrincipal } from "@/lib/auth";

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
    const { sessionId, trackId, partNumber, participantName, deviceLabel, deviceId, isBuiltInMic } = body;

    if (!sessionId || !trackId || partNumber === undefined) {
      return NextResponse.json(
        { error: "sessionId, trackId, and partNumber are required" },
        { status: 400 }
      );
    }

    // AuthZ: host can presign for any session; guest only for the session
    // their cookie is scoped to. This is where we enforce the S3 blast radius.
    const principal = await resolvePrincipal(req, sessionId);
    if (!principal) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (principal.kind === "guest" && principal.sessionId !== sessionId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
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

        const safeDeviceLabel = typeof deviceLabel === "string" && deviceLabel.length > 0 ? deviceLabel : null;
        const safeDeviceId = typeof deviceId === "string" && deviceId.length > 0 ? deviceId : null;
        const safeIsBuiltInMic = typeof isBuiltInMic === "boolean" ? isBuiltInMic : false;

        await db.track.create({
          data: {
            id: trackId,
            sessionId,
            participantName,
            s3Key: trackRecordingKey(sessionId, trackId),
            deviceLabel: safeDeviceLabel,
            deviceId: safeDeviceId,
            isBuiltInMic: safeIsBuiltInMic,
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
