"use client";

// LiveKit implementation of the Transport interface.
// This is the ONLY non-component file allowed to import from "livekit-client".
// If the WebRTC backend is swapped, replace this file with a new implementation
// and update the factory in ./index.ts.
//
// `livekit-client` relies on browser/WebRTC globals. The "use client" directive
// above ensures this module is never bundled for server components/routes.

import {
  ConnectionState,
  Room,
  RoomEvent,
  type RemoteParticipant as LKRemoteParticipant,
  type TrackPublishOptions,
} from "livekit-client";

import type {
  ControlMessage,
  RemoteParticipant,
  Transport,
  TransportEvents,
} from "./types";

const CONTROL_TOPIC = "control";

function toRemoteParticipant(p: LKRemoteParticipant): RemoteParticipant {
  return { identity: p.identity, name: p.name };
}

// Runtime guard: validate that an arbitrary parsed JSON value matches the
// ControlMessage union before passing it to handlers. Returns the typed
// message on success, or null if the payload is malformed. Prevents a
// malicious or buggy peer from crashing local handlers via unexpected shapes.
function parseControlMessage(raw: unknown): ControlMessage | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.type === "recording_start") {
    if (typeof obj.sessionStartedAt !== "string") return null;
    return { type: "recording_start", sessionStartedAt: obj.sessionStartedAt };
  }
  if (obj.type === "recording_stop") {
    return { type: "recording_stop" };
  }
  return null;
}

export class LiveKitTransport implements Transport {
  private room: Room;
  // True when this instance created the Room and therefore owns its lifecycle.
  // When wrapping an externally-managed Room (e.g. from <LiveKitRoom>),
  // connect/disconnect are no-ops.
  private ownsRoom: boolean;

  constructor(room?: Room) {
    if (room) {
      this.room = room;
      this.ownsRoom = false;
    } else {
      this.room = new Room();
      this.ownsRoom = true;
    }
  }

  async connect(opts: { url: string; token: string }): Promise<void> {
    if (!this.ownsRoom) return;
    await this.room.connect(opts.url, opts.token);
  }

  async disconnect(): Promise<void> {
    if (!this.ownsRoom) return;
    await this.room.disconnect();
  }

  async publishAudio(
    stream: MediaStream,
    options?: { audioBitrate?: number; dtx?: boolean },
  ): Promise<void> {
    const [track] = stream.getAudioTracks();
    if (!track) {
      throw new Error("publishAudio: MediaStream has no audio tracks");
    }

    const publishOptions: TrackPublishOptions = {};
    if (options?.audioBitrate !== undefined) {
      publishOptions.audioPreset = { maxBitrate: options.audioBitrate };
    }
    if (options?.dtx !== undefined) {
      publishOptions.dtx = options.dtx;
    }

    await this.room.localParticipant.publishTrack(track, publishOptions);
  }

  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): () => void {
    switch (event) {
      case "participantConnected": {
        const fn = (p: LKRemoteParticipant) => {
          (handler as TransportEvents["participantConnected"])(toRemoteParticipant(p));
        };
        this.room.on(RoomEvent.ParticipantConnected, fn);
        return () => {
          this.room.off(RoomEvent.ParticipantConnected, fn);
        };
      }
      case "participantDisconnected": {
        const fn = (p: LKRemoteParticipant) => {
          (handler as TransportEvents["participantDisconnected"])(toRemoteParticipant(p));
        };
        this.room.on(RoomEvent.ParticipantDisconnected, fn);
        return () => {
          this.room.off(RoomEvent.ParticipantDisconnected, fn);
        };
      }
      case "connected": {
        const fn = () => {
          (handler as TransportEvents["connected"])();
        };
        this.room.on(RoomEvent.Connected, fn);
        return () => {
          this.room.off(RoomEvent.Connected, fn);
        };
      }
      case "disconnected": {
        const fn = () => {
          (handler as TransportEvents["disconnected"])();
        };
        this.room.on(RoomEvent.Disconnected, fn);
        return () => {
          this.room.off(RoomEvent.Disconnected, fn);
        };
      }
      default: {
        const exhaustive: never = event;
        throw new Error(`Unhandled transport event: ${String(exhaustive)}`);
      }
    }
  }

  isConnected(): boolean {
    return this.room.state === ConnectionState.Connected;
  }

  async sendControlMessage(msg: ControlMessage): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(msg));
    await this.room.localParticipant.publishData(bytes, {
      reliable: true,
      topic: CONTROL_TOPIC,
    });
  }

  onControlMessage(
    handler: (
      msg: ControlMessage,
      sender: { identity: string; metadata?: string },
    ) => void,
  ): () => void {
    const fn = (
      payload: Uint8Array,
      participant?: LKRemoteParticipant,
      _kind?: unknown,
      topic?: string,
    ) => {
      if (topic !== CONTROL_TOPIC) return;
      let raw: unknown;
      try {
        raw = JSON.parse(new TextDecoder().decode(payload));
      } catch (err) {
        console.warn("onControlMessage: failed to parse payload", err);
        return;
      }
      const parsed = parseControlMessage(raw);
      if (!parsed) {
        console.warn("onControlMessage: ignoring invalid control message", raw);
        return;
      }
      handler(parsed, {
        identity: participant?.identity ?? "",
        metadata: participant?.metadata,
      });
    };
    this.room.on(RoomEvent.DataReceived, fn);
    return () => {
      this.room.off(RoomEvent.DataReceived, fn);
    };
  }
}
