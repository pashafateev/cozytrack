"use client";

// React hook that yields a Transport bound to the LiveKit Room from <LiveKitRoom>'s
// context. Callers get a Transport they can use to send/receive control messages
// without importing from "livekit-client" themselves.

import { useMemo } from "react";
import { useRoomContext } from "@livekit/components-react";

import { LiveKitTransport } from "./livekit-transport";
import type { Transport } from "./types";

export function useTransport(): Transport {
  const room = useRoomContext();
  return useMemo(() => new LiveKitTransport(room), [room]);
}
