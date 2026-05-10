// Server-side JWT generation for LiveKit. Intentionally NOT wrapped by the
// Transport abstraction — if the transport is swapped, this route gets
// replaced by whatever auth flow the new backend requires.

import { NextRequest, NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";
import { resolvePrincipal } from "@/lib/auth";

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

    // LiveKit rooms are 1:1 with cozytrack sessions, so roomName == sessionId.
    const principal = await resolvePrincipal(req, roomName);
    if (!principal) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (principal.kind === "guest" && principal.sessionId !== roomName) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;

    if (!apiKey || !apiSecret) {
      return NextResponse.json(
        { error: "LiveKit credentials not configured" },
        { status: 500 }
      );
    }

    // Stamp the principal's role into the LiveKit token metadata. Receivers
    // read `participant.metadata` off the LiveKit room to verify that
    // host-only control messages (e.g. recording_start/stop) actually came
    // from a host. Forging this requires forging a LiveKit token, which
    // requires the server-held LIVEKIT_API_SECRET, so the role is trustworthy
    // at the room edge.
    const metadata = JSON.stringify({ role: principal.kind });
    const at = new AccessToken(apiKey, apiSecret, {
      identity: participantName,
      metadata,
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
