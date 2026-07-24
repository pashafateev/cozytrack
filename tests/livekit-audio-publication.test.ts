import { describe, expect, it, vi } from "vitest";
import { LiveKitTransport } from "@/lib/transport/livekit-transport";

function audioStream(track: MediaStreamTrack): MediaStream {
  return {
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
}

function audioTrack(id: string): MediaStreamTrack {
  return {
    id,
    kind: "audio",
    getConstraints: () => ({}),
  } as unknown as MediaStreamTrack;
}

function transportHarness() {
  const replaceTrack = vi.fn(async () => undefined);
  const publicationTrack = { replaceTrack };
  const publication = { track: publicationTrack, audioTrack: publicationTrack };
  const publishTrack = vi.fn(async () => publication);
  const unpublishTrack = vi.fn(async () => publication);
  const room = {
    localParticipant: {
      publishTrack,
      unpublishTrack,
    },
  };

  return {
    publishTrack,
    publicationTrack,
    replaceTrack,
    transport: new LiveKitTransport(room as never),
    unpublishTrack,
  };
}

describe("LiveKitTransport monitor audio publication", () => {
  it("publishes mono without stereo negotiation", async () => {
    const harness = transportHarness();
    const track = audioTrack("monitor-1");

    await harness.transport.publishAudio(audioStream(track), {
      audioBitrate: 128_000,
      dtx: false,
    });

    expect(harness.publishTrack).toHaveBeenCalledWith(track, {
      audioPreset: { maxBitrate: 128_000 },
      dtx: false,
      forceStereo: false,
    });
  });

  it("replaces the existing publication for device or mode changes", async () => {
    const harness = transportHarness();
    const first = audioTrack("monitor-1");
    const second = audioTrack("monitor-2");

    await harness.transport.publishAudio(audioStream(first));
    await harness.transport.publishAudio(audioStream(second));

    expect(harness.publishTrack).toHaveBeenCalledTimes(1);
    expect(harness.replaceTrack).toHaveBeenCalledTimes(1);
    expect(harness.replaceTrack).toHaveBeenCalledWith(second, {
      userProvidedTrack: true,
    });
  });

  it("serializes concurrent replacements without duplicate publications", async () => {
    const harness = transportHarness();
    const first = audioTrack("monitor-1");
    const second = audioTrack("monitor-2");

    await Promise.all([
      harness.transport.publishAudio(audioStream(first)),
      harness.transport.publishAudio(audioStream(second)),
    ]);

    expect(harness.publishTrack).toHaveBeenCalledTimes(1);
    expect(harness.replaceTrack).toHaveBeenCalledTimes(1);
  });

  it("unpublishes the managed monitor track without stopping its bus", async () => {
    const harness = transportHarness();
    const track = audioTrack("monitor-1");

    await harness.transport.publishAudio(audioStream(track));
    await harness.transport.unpublishAudio();

    expect(harness.unpublishTrack).toHaveBeenCalledWith(
      harness.publicationTrack,
      false,
    );
  });
});
