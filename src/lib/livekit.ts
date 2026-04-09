"use client";

export async function getToken(
  roomName: string,
  participantName: string
): Promise<string> {
  const res = await fetch("/api/livekit-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomName, participantName }),
  });

  if (!res.ok) {
    throw new Error(`Failed to get LiveKit token: ${res.statusText}`);
  }

  const data = await res.json();
  return data.token;
}

export const LIVEKIT_URL =
  process.env.NEXT_PUBLIC_LIVEKIT_URL ?? "ws://localhost:7880";
