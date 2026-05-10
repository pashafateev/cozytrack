// Minimal transport abstraction for Cozytrack's WebRTC needs.
// Only covers the imperative operations used outside of React components.
// UI-facing components from @livekit/components-react are NOT wrapped.

export interface RemoteParticipant {
  identity: string;
  name?: string;
}

export interface TransportEvents {
  participantConnected: (participant: RemoteParticipant) => void;
  participantDisconnected: (participant: RemoteParticipant) => void;
  connected: () => void;
  disconnected: () => void;
  // Add more events here as the codebase actually needs them — do not add speculatively.
}

// Discriminated union of control messages broadcast between participants via
// the data channel. Extend this union (not a generic payload) so all senders
// and handlers get type-checked.
export type RecordingStatusState =
  | "connected"
  | "recording"
  | "finalizing"
  | "failed";

export type ControlMessage =
  | { type: "recording_start"; sessionStartedAt: string /* ISO8601 */ }
  | { type: "recording_stop" }
  | {
      type: "recording_status";
      state: RecordingStatusState;
      sessionStartedAt?: string /* ISO8601 */;
      reason?: string;
    };

export interface Transport {
  /**
   * Connect to a room with a token. Returns when connected.
   */
  connect(opts: { url: string; token: string }): Promise<void>;

  /**
   * Disconnect and clean up all resources.
   */
  disconnect(): Promise<void>;

  /**
   * Publish a microphone audio track from a MediaStream.
   * Options intentionally kept small — add fields only as the codebase needs them.
   */
  publishAudio(stream: MediaStream, options?: { audioBitrate?: number; dtx?: boolean }): Promise<void>;

  /**
   * Subscribe to lifecycle events. Returns an unsubscribe function.
   */
  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): () => void;

  /**
   * Is currently connected.
   */
  isConnected(): boolean;

  /**
   * Broadcast a JSON-serializable control message to all other participants.
   * Uses a reliable channel — ordering and delivery are best-effort but not lossy.
   */
  sendControlMessage(msg: ControlMessage): Promise<void>;

  /**
   * Subscribe to control messages from other participants.
   * Returns an unsubscribe function. The sender's identity and (optional)
   * room-level metadata are passed so handlers can distinguish echoes of
   * their own messages (though LiveKit's data channel does not echo to the
   * sender — idempotency should still be enforced by state) and verify
   * sender role for host-only messages. Metadata is whatever string the
   * server stamped onto the participant's token; in cozytrack that's a JSON
   * blob like `{"role":"host"}`. See src/lib/transport/participant-role.ts.
   */
  onControlMessage(
    handler: (
      msg: ControlMessage,
      sender: { identity: string; metadata?: string },
    ) => void,
  ): () => void;
}
