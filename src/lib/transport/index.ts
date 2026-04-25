"use client";

// `livekit-client` relies on browser/WebRTC globals. This barrel has a value
// import of LiveKitTransport, which pulls the LiveKit client implementation
// into any consumer that imports from "@/lib/transport". Marking this module
// "use client" prevents Next.js from bundling `livekit-client` for the server.
//
// Server code that only needs types should import from "@/lib/transport/types"
// directly, which is server-safe.

import { LiveKitTransport } from "./livekit-transport";
import type { Transport } from "./types";

export type {
  ControlMessage,
  RemoteParticipant,
  Transport,
  TransportEvents,
} from "./types";
export { useTransport } from "./use-transport";

/**
 * Create a new Transport instance. The active transport is LiveKit.
 * To swap transports, replace this factory with a different implementation.
 */
export function createTransport(): Transport {
  return new LiveKitTransport();
}
