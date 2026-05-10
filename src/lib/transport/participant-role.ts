// Helpers for reading the participant role that the LiveKit token route
// stamps into `participant.metadata`. Pure functions so they can be unit
// tested without spinning up a Room.
//
// The trust model: LiveKit token metadata is signed server-side with
// LIVEKIT_API_SECRET (see src/app/api/livekit-token/route.ts). A guest
// cannot mint a token claiming role: "host" without the secret, so when
// `participant.metadata` parses to `{ role: "host" }` we trust it.

export type ParticipantRole = "host" | "guest";

/**
 * Parse the participant role from a LiveKit metadata string.
 * Returns null if the metadata is missing or unparseable, or if the role
 * value isn't one we recognize.
 */
export function parseParticipantRole(
  metadata: string | undefined,
): ParticipantRole | null {
  if (!metadata) return null;
  try {
    const obj = JSON.parse(metadata) as unknown;
    if (obj === null || typeof obj !== "object") return null;
    const role = (obj as Record<string, unknown>).role;
    if (role === "host" || role === "guest") return role;
    return null;
  } catch {
    return null;
  }
}

/**
 * Whether a control message from a participant with the given metadata should
 * be honored. Host-only control messages (recording_start, recording_stop) are
 * accepted only when the sender's metadata parses to role: "host". Unknown or
 * missing roles are rejected.
 */
export function isHostSender(metadata: string | undefined): boolean {
  return parseParticipantRole(metadata) === "host";
}
