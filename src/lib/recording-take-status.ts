export const HOST_STOPPED_ROOM_REASON = "host_stopped_room";

const HOST_STOPPED_ROOM_STATUSES = new Set([
  "connected",
  "finalizing",
  "complete",
]);

export function isHostStoppedRoomStatus(status: {
  participantId: string;
  recordingStatus: string | null;
  statusReason: string | null;
}): boolean {
  return (
    status.participantId === "host" &&
    status.statusReason === HOST_STOPPED_ROOM_REASON &&
    Boolean(
      status.recordingStatus &&
        HOST_STOPPED_ROOM_STATUSES.has(status.recordingStatus),
    )
  );
}

export function isParticipantStoppedRecordingStatus(
  status: string | null | undefined,
): boolean {
  return (
    status === "connected" ||
    status === "finalizing" ||
    status === "complete"
  );
}
