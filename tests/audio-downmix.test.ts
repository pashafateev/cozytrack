import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forceMonoStream, getTrackChannelCount } from "@/lib/audio-downmix";

// Minimal Web Audio mocks: we only need to verify that forceMonoStream
// configures the graph for an explicit 1-channel downmix and exposes the
// destination's stream. A real AudioContext can't run in the node test
// environment.

type MockNode = {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  channelCount: number;
  channelCountMode: ChannelCountMode;
  channelInterpretation: ChannelInterpretation;
};

function makeNode(): MockNode {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    channelCount: 2,
    channelCountMode: "max",
    channelInterpretation: "speakers",
  };
}

class MockMediaStream {
  // Just a tag so identity comparisons work.
  readonly _kind = "stream" as const;
  // Default implementation — individual tests may overwrite this to inject
  // spy tracks.
  getTracks(): MediaStreamTrack[] {
    return [];
  }
}

class MockDestinationNode {
  channelCount: number;
  stream = new MockMediaStream() as unknown as MediaStream;
  connect = vi.fn();
  disconnect = vi.fn();
  channelCountMode: ChannelCountMode = "explicit";
  channelInterpretation: ChannelInterpretation = "speakers";

  constructor(_ctx: unknown, opts?: { channelCount?: number }) {
    this.channelCount = opts?.channelCount ?? 2;
  }
}

type MockAudioCtxInstance = {
  closed: boolean;
  createMediaStreamSource: ReturnType<typeof vi.fn>;
  createGain: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function makeMockAudioContextCtor() {
  const sourceNode = makeNode();
  const gainNode = makeNode();
  const destinationCalls: Array<{ args: unknown[]; instance: MockDestinationNode }> = [];
  const audioContextInstances: MockAudioCtxInstance[] = [];

  // Real class so `new ...()` works; spy via a wrapper that records the call.
  function DestinationCtorImpl(this: MockDestinationNode, ctx: unknown, opts?: { channelCount?: number }) {
    const inst = new MockDestinationNode(ctx, opts);
    destinationCalls.push({ args: [ctx, opts], instance: inst });
    return inst;
  }
  // Make it usable as a constructor with `new`.
  const DestinationCtor = DestinationCtorImpl as unknown as new (
    ctx: unknown,
    opts?: { channelCount?: number },
  ) => MockDestinationNode;

  class MockAudioContext {
    closed = false;
    createMediaStreamSource = vi.fn().mockReturnValue(sourceNode);
    createGain = vi.fn().mockReturnValue(gainNode);
    close = vi.fn().mockImplementation(() => {
      this.closed = true;
      return Promise.resolve();
    });
    constructor() {
      audioContextInstances.push(this as MockAudioCtxInstance);
    }
  }

  return {
    Ctor: MockAudioContext as unknown as typeof AudioContext,
    sourceNode,
    gainNode,
    DestinationCtor,
    destinationCalls,
    audioContextInstances,
  };
}

describe("forceMonoStream", () => {
  let originalDestinationCtor: unknown;
  let captured: ReturnType<typeof makeMockAudioContextCtor>;

  beforeEach(() => {
    captured = makeMockAudioContextCtor();
    // forceMonoStream uses `new MediaStreamAudioDestinationNode(ctx, ...)`
    // — patch the global so the mock constructor receives the call.
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

  it("forces the gain node into single-channel explicit downmix mode", () => {
    const fakeStream = {} as MediaStream;
    forceMonoStream(fakeStream, captured.Ctor);

    expect(captured.gainNode.channelCount).toBe(1);
    expect(captured.gainNode.channelCountMode).toBe("explicit");
    expect(captured.gainNode.channelInterpretation).toBe("speakers");
  });

  it("creates a 1-channel destination so the output track is mono", () => {
    const fakeStream = {} as MediaStream;
    forceMonoStream(fakeStream, captured.Ctor);

    expect(captured.destinationCalls).toHaveLength(1);
    expect(captured.destinationCalls[0].args[1]).toEqual({ channelCount: 1 });
    expect(captured.destinationCalls[0].instance.channelCount).toBe(1);
  });

  it("connects source -> gain -> destination", () => {
    const fakeStream = {} as MediaStream;
    forceMonoStream(fakeStream, captured.Ctor);

    expect(captured.sourceNode.connect).toHaveBeenCalledTimes(1);
    expect(captured.sourceNode.connect.mock.calls[0][0]).toBe(captured.gainNode);
    expect(captured.gainNode.connect).toHaveBeenCalledTimes(1);
    // gain must connect to the actual destination instance — asserting the
    // arg is merely defined would let mis-wirings (e.g. gain -> source -> dest)
    // slip through.
    expect(captured.gainNode.connect.mock.calls[0][0]).toBe(
      captured.destinationCalls[0].instance,
    );
  });

  it("returned stream comes from the destination node", () => {
    const fakeStream = {} as MediaStream;
    const { stream } = forceMonoStream(fakeStream, captured.Ctor);
    // The mock destination assigned a sentinel MockMediaStream — the same
    // instance must be what forceMonoStream surfaced to the caller.
    expect((stream as unknown as { _kind?: string })._kind).toBe("stream");
  });

  it("dispose() disconnects nodes and closes the context exactly once", () => {
    const fakeStream = {} as MediaStream;
    const { dispose } = forceMonoStream(fakeStream, captured.Ctor);
    const audioCtx = captured.audioContextInstances[0];

    dispose();
    expect(captured.sourceNode.disconnect).toHaveBeenCalledTimes(1);
    expect(captured.gainNode.disconnect).toHaveBeenCalledTimes(1);
    expect(audioCtx.close).toHaveBeenCalledTimes(1);

    // Idempotent — a second call must not double-close.
    dispose();
    expect(captured.sourceNode.disconnect).toHaveBeenCalledTimes(1);
    expect(captured.gainNode.disconnect).toHaveBeenCalledTimes(1);
    expect(audioCtx.close).toHaveBeenCalledTimes(1);
  });

  it("dispose() stops the synthetic destination stream tracks", () => {
    const fakeStream = {} as MediaStream;
    const stopSpy = vi.fn();
    const fakeTrack = { stop: stopSpy } as unknown as MediaStreamTrack;

    const { dispose } = forceMonoStream(fakeStream, captured.Ctor);
    // Surface a stoppable track on the destination's MediaStream. dispose()
    // hasn't been called yet, so patching now is safe — the closure reads
    // destination.stream.getTracks() lazily inside dispose.
    const destInstance = captured.destinationCalls[0].instance;
    (destInstance.stream as unknown as { getTracks: () => MediaStreamTrack[] })
      .getTracks = () => [fakeTrack];

    dispose();
    expect(stopSpy).toHaveBeenCalledTimes(1);

    // Idempotent — calling dispose again must not re-stop.
    dispose();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it("dispose() swallows rejections from ctx.close()", async () => {
    const fakeStream = {} as MediaStream;
    // Override Ctor so close() rejects.
    class RejectingCtx {
      closed = false;
      createMediaStreamSource = vi.fn().mockReturnValue(captured.sourceNode);
      createGain = vi.fn().mockReturnValue(captured.gainNode);
      close = vi.fn().mockRejectedValue(new Error("already closed"));
    }
    const { dispose } = forceMonoStream(
      fakeStream,
      RejectingCtx as unknown as typeof AudioContext,
    );

    // If dispose did not catch, this would log an unhandled rejection.
    expect(() => dispose()).not.toThrow();
    // Flush microtasks so the rejected promise settles before the test ends.
    await Promise.resolve();
    await Promise.resolve();
  });

  it("throws when no AudioContext is available", () => {
    const fakeStream = {} as MediaStream;
    expect(() => forceMonoStream(fakeStream, undefined)).toThrowError(
      /no AudioContext/,
    );
  });
});

describe("getTrackChannelCount", () => {
  it("returns the reported channelCount when getSettings exposes one", () => {
    const track = {
      getSettings: () => ({ channelCount: 2 }),
    } as unknown as MediaStreamTrack;
    expect(getTrackChannelCount(track)).toBe(2);
  });

  it("returns undefined when getSettings is missing", () => {
    const track = {} as MediaStreamTrack;
    expect(getTrackChannelCount(track)).toBeUndefined();
  });

  it("returns undefined when channelCount is not in settings", () => {
    const track = {
      getSettings: () => ({}),
    } as unknown as MediaStreamTrack;
    expect(getTrackChannelCount(track)).toBeUndefined();
  });
});
