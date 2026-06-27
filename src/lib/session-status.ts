export const FINALIZED_SESSION_ERROR = "Session is already finalized";

export function isRecordingSession(session: { status: string }): boolean {
  return session.status === "recording";
}
