// Helpers for reading the participant role that the LiveKit token route
// stamps into `participant.metadata`. Pure functions so they can be unit
// tested without spinning up a Room.
//
// The trust model: LiveKit token metadata is signed server-side with
// LIVEKIT_API_SECRET (see src/app/api/livekit-token/route.ts). A guest
// cannot mint a token claiming role: "host" without the secret, so when
// `participant.metadata` parses to `{ role: "host" }` we trust it.

export type ParticipantRole = "host" | "guest";
export type ParticipantMetadata = {
  role: ParticipantRole;
  participantId?: string;
  displayName?: string;
};

export function parseParticipantMetadata(
  metadata: string | undefined,
): ParticipantMetadata | null {
  if (!metadata) return null;
  try {
    const obj = JSON.parse(metadata) as unknown;
    if (obj === null || typeof obj !== "object") return null;
    const record = obj as Record<string, unknown>;
    const role = record.role;
    if (role !== "host" && role !== "guest") return null;
    const participantId =
      typeof record.participantId === "string" && record.participantId.length > 0
        ? record.participantId
        : undefined;
    const displayName =
      typeof record.displayName === "string" && record.displayName.length > 0
        ? record.displayName
        : undefined;
    return {
      role,
      ...(participantId !== undefined ? { participantId } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Parse the participant role from a LiveKit metadata string.
 * Returns null if the metadata is missing or unparseable, or if the role
 * value isn't one we recognize.
 */
export function parseParticipantRole(
  metadata: string | undefined,
): ParticipantRole | null {
  return parseParticipantMetadata(metadata)?.role ?? null;
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
