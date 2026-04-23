// LiveKit implementation of the Transport interface.
// This is the ONLY non-component file allowed to import from "livekit-client".
// If the WebRTC backend is swapped, replace this file with a new implementation
// and update the factory in ./index.ts.

import {
  ConnectionState,
  Room,
  RoomEvent,
  type RemoteParticipant as LKRemoteParticipant,
  type TrackPublishOptions,
} from "livekit-client";

import type { RemoteParticipant, Transport, TransportEvents } from "./types";

function toRemoteParticipant(p: LKRemoteParticipant): RemoteParticipant {
  return { identity: p.identity, name: p.name };
}

export class LiveKitTransport implements Transport {
  private room: Room;

  constructor() {
    this.room = new Room();
  }

  async connect(opts: { url: string; token: string }): Promise<void> {
    await this.room.connect(opts.url, opts.token);
  }

  async disconnect(): Promise<void> {
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
}
