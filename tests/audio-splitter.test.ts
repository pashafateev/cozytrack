import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { splitStereoStream } from "@/lib/audio-splitter";

// Minimal Web Audio mocks: we only need to verify that splitStereoStream wires
// a ChannelSplitterNode to two mono destinations and fails closed when the
// device cannot prove 2-channel capture. A real AudioContext can't run in the
// node test environment.

function makeNode() {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

class MockMediaStream {
  readonly _kind = "stream" as const;
  private readonly _tracks: MediaStreamTrack[];
  constructor(tracks: MediaStreamTrack[] = []) {
    this._tracks = tracks;
  }
  getTracks(): MediaStreamTrack[] {
    return this._tracks;
  }
}

class MockDestinationNode {
  channelCount: number;
  stream: MediaStream;
  connect = vi.fn();
  disconnect = vi.fn();
  constructor(_ctx: unknown, opts?: { channelCount?: number }) {
    this.channelCount = opts?.channelCount ?? 2;
    this.stream = new MockMediaStream([
      { stop: vi.fn() } as unknown as MediaStreamTrack,
    ]) as unknown as MediaStream;
  }
}

function makeMockAudioContextCtor() {
  const sourceNode = makeNode();
  const splitterNode = makeNode();
  const destinationCalls: Array<{
    args: unknown[];
    instance: MockDestinationNode;
  }> = [];
  const audioContextInstances: Array<{ close: ReturnType<typeof vi.fn> }> = [];

  function DestinationCtorImpl(
    this: MockDestinationNode,
    ctx: unknown,
    opts?: { channelCount?: number },
  ) {
    const inst = new MockDestinationNode(ctx, opts);
    destinationCalls.push({ args: [ctx, opts], instance: inst });
    return inst;
  }
  const DestinationCtor = DestinationCtorImpl as unknown as new (
    ctx: unknown,
    opts?: { channelCount?: number },
  ) => MockDestinationNode;

  class MockAudioContext {
    createMediaStreamSource = vi.fn().mockReturnValue(sourceNode);
    createChannelSplitter = vi.fn().mockReturnValue(splitterNode);
    close = vi.fn().mockResolvedValue(undefined);
    constructor() {
      audioContextInstances.push(this as unknown as { close: ReturnType<typeof vi.fn> });
    }
  }

  return {
    Ctor: MockAudioContext as unknown as typeof AudioContext,
    sourceNode,
    splitterNode,
    DestinationCtor,
    destinationCalls,
    audioContextInstances,
  };
}

function stereoStream(channelCount: number | undefined): MediaStream {
  const track = {
    stop: vi.fn(),
    getSettings: () => (channelCount === undefined ? {} : { channelCount }),
  } as unknown as MediaStreamTrack;
  return new MockMediaStream([track]) as unknown as MediaStream;
}

describe("splitStereoStream", () => {
  let originalDestinationCtor: unknown;
  let captured: ReturnType<typeof makeMockAudioContextCtor>;

  beforeEach(() => {
    captured = makeMockAudioContextCtor();
    originalDestinationCtor = (
      globalThis as { MediaStreamAudioDestinationNode?: unknown }
    ).MediaStreamAudioDestinationNode;
    (
      globalThis as { MediaStreamAudioDestinationNode: unknown }
    ).MediaStreamAudioDestinationNode = captured.DestinationCtor;
  });

  afterEach(() => {
    (
      globalThis as { MediaStreamAudioDestinationNode?: unknown }
    ).MediaStreamAudioDestinationNode = originalDestinationCtor;
  });

  it("returns two mono output streams when the device proves 2 channels", () => {
    const result = splitStereoStream(stereoStream(2), captured.Ctor);

    expect(result.state).toBe("ok");
    if (result.state !== "ok") throw new Error("expected ok");
    expect(result.channels).toHaveLength(2);
    expect(result.channels[0]).not.toBe(result.channels[1]);
    // Both destinations are single-channel so each output track is mono.
    expect(captured.destinationCalls).toHaveLength(2);
    expect(captured.destinationCalls[0].args[1]).toEqual({ channelCount: 1 });
    expect(captured.destinationCalls[1].args[1]).toEqual({ channelCount: 1 });
  });

  it("routes splitter output 0 to channel 1 and output 1 to channel 2", () => {
    splitStereoStream(stereoStream(2), captured.Ctor);

    // source -> splitter, then splitter output N -> destination N.
    expect(captured.sourceNode.connect).toHaveBeenCalledWith(
      captured.splitterNode,
    );
    const [dest1, dest2] = captured.destinationCalls.map((c) => c.instance);
    expect(captured.splitterNode.connect).toHaveBeenCalledWith(dest1, 0);
    expect(captured.splitterNode.connect).toHaveBeenCalledWith(dest2, 1);
  });

  it("dispose() stops both destination tracks and closes the context once", () => {
    const result = splitStereoStream(stereoStream(2), captured.Ctor);
    if (result.state !== "ok") throw new Error("expected ok");

    const stops = captured.destinationCalls.map(
      (c) => c.instance.stream.getTracks()[0].stop as ReturnType<typeof vi.fn>,
    );
    const ctx = captured.audioContextInstances[0];

    result.dispose();
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(stops[1]).toHaveBeenCalledTimes(1);
    expect(captured.sourceNode.disconnect).toHaveBeenCalledTimes(1);
    expect(captured.splitterNode.disconnect).toHaveBeenCalledTimes(1);
    expect(ctx.close).toHaveBeenCalledTimes(1);

    // Idempotent — a second call must not double-stop or double-close.
    result.dispose();
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it("fails closed as unsupported when no AudioContext is available", () => {
    const result = splitStereoStream(stereoStream(2), undefined);
    expect(result.state).toBe("unsupported");
    // No graph should have been constructed.
    expect(captured.destinationCalls).toHaveLength(0);
  });

  it("fails closed as unsupported when the source has no audio track", () => {
    const empty = new MockMediaStream([]) as unknown as MediaStream;
    const result = splitStereoStream(empty, captured.Ctor);
    expect(result.state).toBe("unsupported");
    expect(captured.destinationCalls).toHaveLength(0);
  });

  it("fails closed as missing-channels when the device reports mono", () => {
    const result = splitStereoStream(stereoStream(1), captured.Ctor);
    expect(result.state).toBe("missing-channels");
    if (result.state !== "missing-channels") throw new Error("expected missing-channels");
    expect(result.channelCount).toBe(1);
    expect(captured.destinationCalls).toHaveLength(0);
  });

  it("fails closed when channel count cannot be determined", () => {
    const result = splitStereoStream(stereoStream(undefined), captured.Ctor);
    // Cannot *prove* 2 channels — fail closed rather than record a silent
    // duplicated channel.
    expect(result.state).not.toBe("ok");
    expect(captured.destinationCalls).toHaveLength(0);
  });
});
