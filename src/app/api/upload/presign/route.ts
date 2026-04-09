import { NextRequest, NextResponse } from "next/server";
import { trackPartKey, getPresignedPutUrl } from "@/lib/s3";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { sessionId, trackId, partNumber } = body;

    if (!sessionId || !trackId || partNumber === undefined) {
      return NextResponse.json(
        { error: "sessionId, trackId, and partNumber are required" },
        { status: 400 }
      );
    }

    const key = trackPartKey(sessionId, trackId, partNumber);
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
