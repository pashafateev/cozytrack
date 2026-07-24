import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMonitorBus } from "@/lib/monitor-bus";

type MockNode = {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

type MockGainNode = MockNode & {
  gain: { value: number };
  channelCount: number;
  channelCountMode: ChannelCountMode;
  channelInterpretation: ChannelInterpretation;
};

function node(): MockNode {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

function gainNode(): MockGainNode {
  return {
    ...node(),
    gain: { value: -1 },
    channelCount: 2,
    channelCountMode: "max",
    channelInterpretation: "speakers",
  };
}

function stream(track = { stop: vi.fn() } as unknown as MediaStreamTrack) {
  return {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

class MockDestinationNode {
  readonly channelCount: number;
  readonly stream = stream();

  constructor(_ctx: unknown, options?: { channelCount?: number }) {
    this.channelCount = options?.channelCount ?? 2;
  }
}

function audioHarness() {
  const sources = [node(), node()];
  const gains = [gainNode(), gainNode()];
  const contexts: Array<{ close: ReturnType<typeof vi.fn> }> = [];
  const destinations: MockDestinationNode[] = [];

  class MockAudioContext {
    createMediaStreamSource = vi
      .fn()
      .mockReturnValueOnce(sources[0])
      .mockReturnValueOnce(sources[1]);
    createGain = vi.fn().mockReturnValueOnce(gains[0]).mockReturnValueOnce(gains[1]);
    close = vi.fn().mockResolvedValue(undefined);

    constructor() {
      contexts.push(this);
    }
  }

  function DestinationCtor(
    this: MockDestinationNode,
    ctx: unknown,
    options?: { channelCount?: number },
  ) {
    const destination = new MockDestinationNode(ctx, options);
    destinations.push(destination);
    return destination;
  }

  return {
    AudioContextCtor: MockAudioContext as unknown as typeof AudioContext,
    DestinationCtor: DestinationCtor as unknown as typeof MediaStreamAudioDestinationNode,
    contexts,
    destinations,
    gains,
    sources,
  };
}

describe("createMonitorBus", () => {
  let originalDestinationCtor: unknown;
  let harness: ReturnType<typeof audioHarness>;

  beforeEach(() => {
    harness = audioHarness();
    originalDestinationCtor = (
      globalThis as { MediaStreamAudioDestinationNode?: unknown }
    ).MediaStreamAudioDestinationNode;
    (
      globalThis as { MediaStreamAudioDestinationNode: unknown }
    ).MediaStreamAudioDestinationNode = harness.DestinationCtor;
  });

  afterEach(() => {
    (
      globalThis as { MediaStreamAudioDestinationNode?: unknown }
    ).MediaStreamAudioDestinationNode = originalDestinationCtor;
  });

  it("publishes the primary mono input at unity gain in one-channel mode", () => {
    const primary = stream();

    createMonitorBus(primary, undefined, harness.AudioContextCtor);

    expect(harness.gains[0].gain.value).toBe(1);
    expect(harness.sources[0].connect).toHaveBeenCalledWith(harness.gains[0]);
    expect(harness.sources[1].connect).not.toHaveBeenCalled();
  });

  it("combines both mono inputs at half gain in two-channel mode", () => {
    createMonitorBus(stream(), stream(), harness.AudioContextCtor);

    expect(harness.gains[0].gain.value).toBe(0.5);
    expect(harness.gains[1].gain.value).toBe(0.5);
    expect(harness.gains[0]).toMatchObject({
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    expect(harness.gains[1]).toMatchObject({
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    expect(harness.gains[0].connect).toHaveBeenCalledWith(
      harness.destinations[0],
    );
    expect(harness.gains[1].connect).toHaveBeenCalledWith(
      harness.destinations[0],
    );
  });

  it("emits a true one-channel stream so receivers center identical samples", () => {
    const result = createMonitorBus(
      stream(),
      stream(),
      harness.AudioContextCtor,
    );

    expect(harness.destinations).toHaveLength(1);
    expect(harness.destinations[0].channelCount).toBe(1);
    expect(result.stream).toBe(harness.destinations[0].stream);
  });

  it("disposes the synthetic output and graph exactly once", () => {
    const result = createMonitorBus(
      stream(),
      stream(),
      harness.AudioContextCtor,
    );
    const outputTrack = result.stream.getTracks()[0];

    result.dispose();
    result.dispose();

    expect(outputTrack.stop).toHaveBeenCalledTimes(1);
    expect(harness.sources[0].disconnect).toHaveBeenCalledTimes(1);
    expect(harness.sources[1].disconnect).toHaveBeenCalledTimes(1);
    expect(harness.gains[0].disconnect).toHaveBeenCalledTimes(1);
    expect(harness.gains[1].disconnect).toHaveBeenCalledTimes(1);
    expect(harness.contexts[0].close).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the mono graph cannot be created", () => {
    (
      globalThis as { MediaStreamAudioDestinationNode: unknown }
    ).MediaStreamAudioDestinationNode = function () {
      throw new Error("destination unavailable");
    };

    expect(() =>
      createMonitorBus(stream(), undefined, harness.AudioContextCtor),
    ).toThrow(/destination unavailable/);
    expect(harness.contexts[0].close).toHaveBeenCalledTimes(1);
  });
});
