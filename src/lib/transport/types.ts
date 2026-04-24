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
}
