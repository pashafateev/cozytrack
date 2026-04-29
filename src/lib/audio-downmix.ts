"use client";

// Force the encoder to see a true single-channel input regardless of what
// the device actually delivered.
//
// `getUserMedia({ audio: { channelCount: 1 } })` is advisory under the W3C
// spec: many devices (built-in mic on some macOS Chromes, AirPods, certain
// USB mics) hand back a 2-channel track even when mono was requested. The
// browser then pads the second channel with silence, the recorder dutifully
// encodes both channels, and the resulting WebM is stereo with a silent
// right channel. See issue #46.
//
// We can't trust `track.getSettings().channelCount` either — Chrome has
// shipped versions that report 1 while the actual track produced 2 channels.
// The robust fix is to downmix in JS via Web Audio: a GainNode with
// channelCount=1, channelCountMode='explicit', channelInterpretation='speakers'
// performs the standard L/R-average downmix; the destination node is then
// configured to expose a single channel on its output stream.
//
// The returned stream's audio track replaces the original for recording. The
// caller is responsible for keeping the original live (Web Audio holds a
// reference) and calling `dispose()` once recording stops.

export type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

export type ForceMonoResult = {
  stream: MediaStream;
  dispose: () => void;
};

export function forceMonoStream(
  source: MediaStream,
  AudioCtxCtor?: AudioContextCtor,
): ForceMonoResult {
  const Ctor =
    AudioCtxCtor ??
    (typeof window !== "undefined"
      ? (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: AudioContextCtor })
          .webkitAudioContext)
      : undefined);

  if (!Ctor) {
    throw new Error("forceMonoStream: no AudioContext available");
  }

  const ctx = new Ctor();
  const sourceNode = ctx.createMediaStreamSource(source);
  // GainNode acts as the explicit downmix: channelCount=1 +
  // channelCountMode='explicit' forces the standard L/R average mix.
  const downmix = ctx.createGain();
  downmix.channelCount = 1;
  downmix.channelCountMode = "explicit";
  downmix.channelInterpretation = "speakers";
  // Destination must also be 1-channel so the resulting MediaStreamTrack is
  // emitted as a mono track (not a stereo track with a duplicated channel).
  const destination = new MediaStreamAudioDestinationNode(ctx, { channelCount: 1 });

  sourceNode.connect(downmix);
  downmix.connect(destination);

  let disposed = false;
  return {
    stream: destination.stream,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        sourceNode.disconnect();
      } catch {
        // Already disconnected — ignore.
      }
      try {
        downmix.disconnect();
      } catch {
        // Already disconnected — ignore.
      }
      // Stop the synthetic destination track so callers that drop their
      // reference don't leak a live MediaStreamTrack waiting for `ended`.
      // AudioContext.close() alone does not reliably end the track on every
      // browser.
      for (const track of destination.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Already stopped or unavailable — ignore.
        }
      }
      // close() can reject on already-closed/suspended contexts or browser
      // quirks. Swallow so dispose stays best-effort and silent — an
      // unhandled rejection here would surface in app-level error logging.
      void ctx.close().catch(() => {
        // Ignore close failures.
      });
    },
  };
}

// Lightweight, side-effect-free helper used by callers that want to log or
// telemetry-trace whether a track came back stereo despite mono being
// requested. Browser implementations are inconsistent — treat the return
// value as advisory; the actual recording path should always go through
// `forceMonoStream` regardless.
export function getTrackChannelCount(track: MediaStreamTrack): number | undefined {
  if (typeof track.getSettings !== "function") return undefined;
  const settings = track.getSettings() as MediaTrackSettings & { channelCount?: number };
  return settings.channelCount;
}
