import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SYNC_MARKER_DURATION_MS,
  SYNC_MARKER_OFFSET_MS,
  SYNC_MARKER_VERSION,
  createSyncMarkerRecordingStream,
} from "@/lib/recording-sync-marker";

type MockNode = {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

type MockAudioParam = {
  value: number;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
  setValueAtTime: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
};

function makeNode(): MockNode {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
}

function makeAudioParam(): MockAudioParam {
  return {
    value: 1,
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  };
}

class MockMediaStream {
  readonly _kind = "marker-stream" as const;
  getTracks(): MediaStreamTrack[] {
    return [];
  }
}

class MockDestinationNode {
  channelCount: number;
  stream = new MockMediaStream() as unknown as MediaStream;

  constructor(_ctx: unknown, opts?: { channelCount?: number }) {
    this.channelCount = opts?.channelCount ?? 2;
  }
}

function makeMockAudioContextCtor() {
  const sourceNode = makeNode();
  const micGain = makeNode() as MockNode & { gain: MockAudioParam };
  micGain.gain = makeAudioParam();
  const markerGain = makeNode() as MockNode & { gain: MockAudioParam };
  markerGain.gain = makeAudioParam();
  const oscillator = makeNode() as MockNode & {
    type: OscillatorType;
    frequency: MockAudioParam;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    onended: (() => void) | null;
  };
  oscillator.type = "sine";
  oscillator.frequency = makeAudioParam();
  oscillator.start = vi.fn();
  oscillator.stop = vi.fn();
  oscillator.onended = null;

  const destinationCalls: Array<{
    args: unknown[];
    instance: MockDestinationNode;
  }> = [];
  const instances: Array<{
    currentTime: number;
    state: AudioContextState;
    createMediaStreamSource: ReturnType<typeof vi.fn>;
    createGain: ReturnType<typeof vi.fn>;
    createOscillator: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];

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
    currentTime = 10;
    state: AudioContextState = "suspended";
    createMediaStreamSource = vi.fn().mockReturnValue(sourceNode);
    createGain = vi
      .fn()
      .mockReturnValueOnce(micGain)
      .mockReturnValueOnce(markerGain);
    createOscillator = vi.fn().mockReturnValue(oscillator);
    resume = vi.fn().mockImplementation(async () => {
      this.state = "running";
    });
    close = vi.fn().mockResolvedValue(undefined);

    constructor() {
      instances.push(this);
    }
  }

  return {
    Ctor: MockAudioContext as unknown as typeof AudioContext,
    sourceNode,
    micGain,
    markerGain,
    oscillator,
    DestinationCtor,
    destinationCalls,
    instances,
  };
}

describe("createSyncMarkerRecordingStream", () => {
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

  it("mixes the microphone and marker into a mono destination stream", () => {
    const fakeStream = {} as MediaStream;
    const graph = createSyncMarkerRecordingStream(fakeStream, captured.Ctor);

    expect(captured.destinationCalls).toHaveLength(1);
    expect(captured.destinationCalls[0].args[1]).toEqual({ channelCount: 1 });
    expect(captured.sourceNode.connect).toHaveBeenCalledWith(captured.micGain);
    expect(captured.micGain.connect).toHaveBeenCalledWith(
      captured.destinationCalls[0].instance,
    );
    expect(captured.markerGain.connect).toHaveBeenCalledWith(
      captured.destinationCalls[0].instance,
    );
    expect((graph.stream as unknown as { _kind?: string })._kind).toBe(
      "marker-stream",
    );
  });

  it("prepares the marker stream only after the AudioContext is running", async () => {
    const fakeStream = {} as MediaStream;
    const graph = createSyncMarkerRecordingStream(fakeStream, captured.Ctor);

    await expect(graph.prepare()).resolves.toMatchObject({
      version: SYNC_MARKER_VERSION,
      offsetMs: SYNC_MARKER_OFFSET_MS,
      durationMs: SYNC_MARKER_DURATION_MS,
    });

    expect(captured.instances[0].resume).toHaveBeenCalledTimes(1);
    expect(captured.instances[0].state).toBe("running");
  });

  it("rejects prepare when the AudioContext cannot resume", async () => {
    const fakeStream = {} as MediaStream;
    const graph = createSyncMarkerRecordingStream(fakeStream, captured.Ctor);
    captured.instances[0].resume.mockRejectedValueOnce(
      new Error("activation blocked"),
    );

    await expect(graph.prepare()).rejects.toThrowError(
      /AudioContext failed to resume/,
    );
  });

  it("rejects prepare when the AudioContext remains suspended", async () => {
    const fakeStream = {} as MediaStream;
    const graph = createSyncMarkerRecordingStream(fakeStream, captured.Ctor);
    captured.instances[0].resume.mockImplementationOnce(async () => undefined);

    await expect(graph.prepare()).rejects.toThrowError(
      /AudioContext stayed suspended/,
    );
  });

  it("schedules a clipping-safe chirp marker after the recorder pre-roll offset", async () => {
    const fakeStream = {} as MediaStream;
    const graph = createSyncMarkerRecordingStream(fakeStream, captured.Ctor);
    const marker = await graph.playSyncMarker();

    const startAt = 10 + SYNC_MARKER_OFFSET_MS / 1000;
    const endAt = startAt + SYNC_MARKER_DURATION_MS / 1000;

    expect(marker).toMatchObject({
      version: SYNC_MARKER_VERSION,
      offsetMs: SYNC_MARKER_OFFSET_MS,
      durationMs: SYNC_MARKER_DURATION_MS,
    });
    expect(captured.instances[0].resume).toHaveBeenCalledTimes(1);
    expect(captured.oscillator.frequency.setValueAtTime).toHaveBeenCalledWith(
      expect.any(Number),
      startAt,
    );
    expect(
      captured.oscillator.frequency.linearRampToValueAtTime,
    ).toHaveBeenCalledWith(expect.any(Number), endAt);
    expect(captured.markerGain.gain.setValueAtTime).toHaveBeenCalledWith(
      0,
      startAt,
    );
    expect(captured.markerGain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(
      expect.any(Number),
      startAt + 0.01,
    );
    expect(captured.markerGain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(
      0,
      endAt,
    );
    expect(captured.oscillator.connect).toHaveBeenCalledWith(
      captured.markerGain,
    );
    expect(captured.oscillator.start).toHaveBeenCalledWith(startAt);
    expect(captured.oscillator.stop).toHaveBeenCalledWith(endAt);
  });

  it("dispose disconnects nodes, stops destination tracks, and closes once", () => {
    const stop = vi.fn();
    const fakeTrack = { stop } as unknown as MediaStreamTrack;
    const graph = createSyncMarkerRecordingStream({} as MediaStream, captured.Ctor);
    const dest = captured.destinationCalls[0].instance;
    (dest.stream as unknown as { getTracks: () => MediaStreamTrack[] }).getTracks =
      () => [fakeTrack];

    graph.dispose();
    graph.dispose();

    expect(captured.sourceNode.disconnect).toHaveBeenCalledTimes(1);
    expect(captured.micGain.disconnect).toHaveBeenCalledTimes(1);
    expect(captured.markerGain.disconnect).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(captured.instances[0].close).toHaveBeenCalledTimes(1);
  });

  it("throws when no AudioContext is available", () => {
    expect(() =>
      createSyncMarkerRecordingStream({} as MediaStream, undefined),
    ).toThrowError(/no AudioContext/);
  });
});
