"use client";

import type { AudioContextCtor } from "@/lib/audio-downmix";

export type MonitorBus = {
  stream: MediaStream;
  dispose: () => void;
};

function resolveAudioContextCtor(
  AudioCtxCtor?: AudioContextCtor,
): AudioContextCtor | undefined {
  return (
    AudioCtxCtor ??
    (typeof window !== "undefined"
      ? (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: AudioContextCtor })
          .webkitAudioContext)
      : undefined)
  );
}

function closeAudioContext(ctx: AudioContext | undefined) {
  if (!ctx) return;
  try {
    void ctx.close().catch(() => {
      // Best-effort graph teardown.
    });
  } catch {
    // Some browser implementations can throw synchronously during teardown.
  }
}

/**
 * Build the mono track published for realtime conversation.
 *
 * The inputs are already-mono capture streams. With one input, channel 1
 * passes at unity gain. With two, each input is attenuated by 6 dB before
 * summing so coincident full-scale signals retain deterministic headroom.
 * The one-channel destination is the hard centering guarantee: LiveKit never
 * receives either raw interface channel.
 */
export function createMonitorBus(
  primary: MediaStream,
  secondary?: MediaStream,
  AudioCtxCtor?: AudioContextCtor,
): MonitorBus {
  const Ctor = resolveAudioContextCtor(AudioCtxCtor);
  if (!Ctor) {
    throw new Error("createMonitorBus: no AudioContext available");
  }
  if (primary.getAudioTracks().length === 0) {
    throw new Error("createMonitorBus: primary stream has no audio track");
  }
  if (secondary && secondary.getAudioTracks().length === 0) {
    throw new Error("createMonitorBus: secondary stream has no audio track");
  }

  let ctx: AudioContext | undefined;
  const sources: MediaStreamAudioSourceNode[] = [];
  const gains: GainNode[] = [];
  let destination: MediaStreamAudioDestinationNode | undefined;

  try {
    ctx = new Ctor();
    destination = new MediaStreamAudioDestinationNode(ctx, {
      channelCount: 1,
    });

    const inputs = secondary ? [primary, secondary] : [primary];
    const gainValue = secondary ? 0.5 : 1;
    for (const input of inputs) {
      const source = ctx.createMediaStreamSource(input);
      const gain = ctx.createGain();
      gain.gain.value = gainValue;
      gain.channelCount = 1;
      gain.channelCountMode = "explicit";
      gain.channelInterpretation = "speakers";
      source.connect(gain);
      gain.connect(destination);
      sources.push(source);
      gains.push(gain);
    }
  } catch (error) {
    for (const source of sources) {
      try {
        source.disconnect();
      } catch {
        // Ignore partially-connected graph teardown.
      }
    }
    for (const gain of gains) {
      try {
        gain.disconnect();
      } catch {
        // Ignore partially-connected graph teardown.
      }
    }
    for (const track of destination?.stream.getTracks() ?? []) {
      try {
        track.stop();
      } catch {
        // Ignore partially-created destination teardown.
      }
    }
    closeAudioContext(ctx);
    throw error;
  }

  const activeContext = ctx;
  const activeDestination = destination;
  let disposed = false;
  return {
    stream: activeDestination.stream,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const source of sources) {
        try {
          source.disconnect();
        } catch {
          // Already disconnected.
        }
      }
      for (const gain of gains) {
        try {
          gain.disconnect();
        } catch {
          // Already disconnected.
        }
      }
      for (const track of activeDestination.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Already stopped.
        }
      }
      closeAudioContext(activeContext);
    },
  };
}
