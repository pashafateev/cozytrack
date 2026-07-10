"use client";

// Split one 2-channel input stream into two independent mono MediaStreams —
// the capture primitive behind host-owned two-channel local recording (issue
// #135). A host points Cozytrack at a single desktop audio interface that
// carries two distinct sources on its left/right channels (e.g. two mics into
// a small mixer, or a loopback of two apps) and records each channel as its
// own logical track.
//
// We deliberately fail closed. `getUserMedia({ channelCount: 2 })` is advisory
// (see the sibling reasoning in `@/lib/audio-downmix`): a device may hand back
// a 1-channel track, or a 2-channel track whose right channel is silent
// padding. If we cannot *prove* the source carries two channels we return an
// explicit `unsupported`/`missing-channels` state instead of silently
// recording a duplicated or empty second channel. The caller surfaces that to
// the host rather than shipping a broken take.
//
// Web Audio wiring: a ChannelSplitterNode fans the source's channels out to
// numbered outputs; output 0 feeds a 1-channel destination (Local Ch 1) and
// output 1 feeds a second (Local Ch 2). Each destination exposes a mono
// MediaStreamTrack. The caller keeps the source stream live (Web Audio holds a
// reference) and calls `dispose()` when recording stops.

import { getTrackChannelCount } from "@/lib/audio-downmix";
import type { AudioContextCtor } from "@/lib/audio-downmix";

export type SplitStereoResult =
  | { state: "ok"; channels: [MediaStream, MediaStream]; dispose: () => void }
  | { state: "unsupported"; reason: string }
  | { state: "missing-channels"; reason: string; channelCount: number };

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

export function splitStereoStream(
  source: MediaStream,
  AudioCtxCtor?: AudioContextCtor,
): SplitStereoResult {
  const Ctor = resolveAudioContextCtor(AudioCtxCtor);
  if (!Ctor) {
    return { state: "unsupported", reason: "no AudioContext available" };
  }

  const [sourceTrack] = source.getAudioTracks
    ? source.getAudioTracks()
    : source.getTracks();
  if (!sourceTrack) {
    return { state: "unsupported", reason: "source stream has no audio track" };
  }

  // Fail closed: only proceed when the device positively reports >= 2 channels.
  const channelCount = getTrackChannelCount(sourceTrack);
  if (channelCount === undefined) {
    return {
      state: "unsupported",
      reason: "device did not report a channel count; cannot prove 2 channels",
    };
  }
  if (channelCount < 2) {
    return {
      state: "missing-channels",
      reason: `device reported ${channelCount} channel(s); need 2`,
      channelCount,
    };
  }

  // Build the graph inside a try so construction failures (e.g. a browser
  // without MediaStreamAudioDestinationNode, or one that rejects the options)
  // fail closed rather than throwing. On failure we tear down whatever context
  // we created and return an explicit state — the caller still owns and stops
  // the source stream. Failing closed here keeps every caller's cleanup path
  // simple: a non-"ok" result is the single signal to stop the input stream.
  let ctx: AudioContext | undefined;
  let sourceNode: MediaStreamAudioSourceNode;
  let splitter: ChannelSplitterNode;
  let dest1: MediaStreamAudioDestinationNode;
  let dest2: MediaStreamAudioDestinationNode;
  try {
    ctx = new Ctor();
    sourceNode = ctx.createMediaStreamSource(source);
    splitter = ctx.createChannelSplitter(2);
    sourceNode.connect(splitter);

    dest1 = new MediaStreamAudioDestinationNode(ctx, { channelCount: 1 });
    dest2 = new MediaStreamAudioDestinationNode(ctx, { channelCount: 1 });
    // Splitter output N carries source channel N. Wire each to its own mono
    // destination so the two channels never bleed into one another.
    splitter.connect(dest1, 0);
    splitter.connect(dest2, 1);
  } catch (err) {
    try {
      void ctx?.close();
    } catch {
      // Ignore teardown failures on the partially-built context.
    }
    return {
      state: "unsupported",
      reason: `failed to construct split audio graph: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const activeCtx = ctx;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try {
      sourceNode.disconnect();
    } catch {
      // Already disconnected — ignore.
    }
    try {
      splitter.disconnect();
    } catch {
      // Already disconnected — ignore.
    }
    // Stop the synthetic destination tracks so callers that drop their
    // reference don't leak live MediaStreamTracks. AudioContext.close() alone
    // does not reliably end them on every browser.
    for (const dest of [dest1, dest2]) {
      for (const track of dest.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Already stopped or unavailable — ignore.
        }
      }
    }
    // close() can reject on already-closed/suspended contexts. Swallow so
    // dispose stays best-effort and silent.
    void activeCtx?.close().catch(() => {
      // Ignore close failures.
    });
  };

  return { state: "ok", channels: [dest1.stream, dest2.stream], dispose };
}
