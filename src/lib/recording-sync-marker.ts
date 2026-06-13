"use client";

import {
  SYNC_MARKER_DURATION_MS,
  SYNC_MARKER_OFFSET_MS,
  SYNC_MARKER_VERSION,
  syncMarkerMetadata,
  type SyncMarkerMetadata,
} from "@/lib/sync-marker";

export {
  SYNC_MARKER_DURATION_MS,
  SYNC_MARKER_OFFSET_MS,
  SYNC_MARKER_VERSION,
  syncMarkerMetadata,
};
export type { SyncMarkerMetadata };

export type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

export const SYNC_MARKER_START_FREQUENCY_HZ = 1200;
export const SYNC_MARKER_END_FREQUENCY_HZ = 3200;
export const SYNC_MARKER_GAIN = 0.12;

export type SyncMarkerRecordingStream = {
  stream: MediaStream;
  marker: SyncMarkerMetadata;
  playSyncMarker: () => Promise<SyncMarkerMetadata>;
  dispose: () => void;
};

function getAudioContextCtor(AudioCtxCtor?: AudioContextCtor): AudioContextCtor | undefined {
  return (
    AudioCtxCtor ??
    (typeof window !== "undefined"
      ? (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: AudioContextCtor })
          .webkitAudioContext)
      : undefined)
  );
}

export function createSyncMarkerRecordingStream(
  source: MediaStream,
  AudioCtxCtor?: AudioContextCtor,
): SyncMarkerRecordingStream {
  const Ctor = getAudioContextCtor(AudioCtxCtor);
  if (!Ctor) {
    throw new Error("createSyncMarkerRecordingStream: no AudioContext available");
  }

  const ctx = new Ctor({ sampleRate: 48000 });
  const sourceNode = ctx.createMediaStreamSource(source);
  const micGain = ctx.createGain();
  const markerGain = ctx.createGain();
  markerGain.gain.value = 0;

  const destination = new MediaStreamAudioDestinationNode(ctx, { channelCount: 1 });

  sourceNode.connect(micGain);
  micGain.connect(destination);
  markerGain.connect(destination);

  let disposed = false;

  return {
    stream: destination.stream,
    marker: syncMarkerMetadata(),
    playSyncMarker: async () => {
      if (disposed) return syncMarkerMetadata();

      if (ctx.state === "suspended") {
        await ctx.resume().catch(() => undefined);
      }

      const startAt = ctx.currentTime + SYNC_MARKER_OFFSET_MS / 1000;
      const endAt = startAt + SYNC_MARKER_DURATION_MS / 1000;
      const oscillator = ctx.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(SYNC_MARKER_START_FREQUENCY_HZ, startAt);
      oscillator.frequency.linearRampToValueAtTime(
        SYNC_MARKER_END_FREQUENCY_HZ,
        endAt,
      );

      markerGain.gain.cancelScheduledValues(startAt);
      markerGain.gain.setValueAtTime(0, startAt);
      markerGain.gain.linearRampToValueAtTime(SYNC_MARKER_GAIN, startAt + 0.01);
      markerGain.gain.setValueAtTime(SYNC_MARKER_GAIN, endAt - 0.02);
      markerGain.gain.linearRampToValueAtTime(0, endAt);

      oscillator.connect(markerGain);
      oscillator.start(startAt);
      oscillator.stop(endAt);
      oscillator.onended = () => {
        try {
          oscillator.disconnect();
        } catch {
          // Already disconnected; ignore.
        }
      };

      return syncMarkerMetadata();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        sourceNode.disconnect();
      } catch {
        // Already disconnected; ignore.
      }
      try {
        micGain.disconnect();
      } catch {
        // Already disconnected; ignore.
      }
      try {
        markerGain.disconnect();
      } catch {
        // Already disconnected; ignore.
      }
      for (const track of destination.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Already stopped; ignore.
        }
      }
      void ctx.close().catch(() => undefined);
    },
  };
}
