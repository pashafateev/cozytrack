import { LiveKitTransport } from "./livekit-transport";
import type { Transport } from "./types";

export type { Transport, RemoteParticipant, TransportEvents } from "./types";

/**
 * Create a new Transport instance. The active transport is LiveKit.
 * To swap transports, replace this factory with a different implementation.
 */
export function createTransport(): Transport {
  return new LiveKitTransport();
}
