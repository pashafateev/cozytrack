import { NextRequest, NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { roomName, participantName } = body;

    if (!roomName || !participantName) {
      return NextResponse.json(
        { error: "roomName and participantName are required" },
        { status: 400 }
      );
    }

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;

    if (!apiKey || !apiSecret) {
      return NextResponse.json(
        { error: "LiveKit credentials not configured" },
        { status: 500 }
      );
    }

    const at = new AccessToken(apiKey, apiSecret, {
      identity: participantName,
    });
    at.addGrant({ roomJoin: true, room: roomName });
    const token = await at.toJwt();

    return NextResponse.json({ token });
  } catch (error) {
    console.error("Failed to generate LiveKit token:", error);
    return NextResponse.json(
      { error: "Failed to generate token" },
      { status: 500 }
    );
  }
}
