import React, { type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, vi } from "vitest";
import StudioPage from "@/app/studio/[id]/page";
import type { ControlMessage } from "@/lib/transport/types";

type AuthMeResponse =
  | { role: "guest"; name: string }
  | { role: "host" };

export type RemoteParticipantStub = {
  identity: string;
  name?: string;
  metadata?: string;
};

type ControlMessageHandler = (
  message: ControlMessage,
  sender: { identity: string; metadata?: string },
) => void;

type MockRoomConnectionState =
  | "connected"
  | "connecting"
  | "reconnecting"
  | "disconnected";

const studioPageHarness = vi.hoisted(() => ({
  authMeResponse: { role: "guest", name: "Guest Alice" } as AuthMeResponse,
  route: {
    sessionId: "session-guest",
  },
  // Backing store for the useRemoteParticipants mock. Tests mutate it through
  // setRemoteParticipants (wrapped in act) — the listeners let the mocked hook
  // re-render subscribers exactly like the real LiveKit hook would.
  remoteParticipants: [] as Array<{
    identity: string;
    name?: string;
    metadata?: string;
  }>,
  remoteParticipantsListeners: new Set<() => void>(),
  navigationGuard: vi.fn(),
  retryLocalRecordingBackupUpload: vi.fn(),
  getToken: vi.fn(async () => "livekit-token"),
  sendControlMessage: vi.fn(async (_message: { type: string }) => undefined),
  onControlMessage: vi.fn((_handler: ControlMessageHandler) => vi.fn()),
  isHostSender: vi.fn(),
  setMicrophoneEnabled: vi.fn(async (_enabled: boolean) => undefined),
  autoConnectRoom: true,
  roomConnectionState: "connected" as MockRoomConnectionState,
  roomOnConnected: undefined as (() => void) | undefined,
  liveKitAudioProp: undefined as unknown,
  republishAllTracks: vi.fn(async () => undefined),
  publishAudio: vi.fn(async () => undefined),
  unpublishAudio: vi.fn(async () => undefined),
  getUserMedia: vi.fn(),
  enumerateDevices: vi.fn(),
  listBackups: vi.fn(async (): Promise<unknown[]> => []),
  audioContexts: [] as unknown[],
  startRecordingTake: vi.fn(),
  stopRecordingTake: vi.fn(),
  getRecordingTakeState: vi.fn(),
  reportRecordingTakeParticipantStatus: vi.fn(async () => undefined),
  getPresignedUploadTarget: vi.fn(),
  getPresignedUploadUrl: vi.fn(async () => "https://s3.example/recording.webm"),
  uploadChunk: vi.fn(async () => undefined),
  completeUpload: vi.fn(async () => undefined),
  recorderOnChunk: vi.fn(),
  recorderStart: vi.fn(async () => undefined),
  recorderStop: vi.fn(),
  recorderChunkHandler: undefined as
    | ((chunk: Blob, index: number) => void)
    | undefined,
  syncMarkerPrepare: vi.fn(async () => undefined),
  syncMarkerPlay: vi.fn(async () => undefined),
  syncMarkerDispose: vi.fn(),
  splitStereoStream: vi.fn(),
  splitterDispose: vi.fn(),
  createMonitorBus: vi.fn(),
  monitorBusDispose: vi.fn(),
  recordingBackupStore: {
    startBackup: vi.fn(),
    saveChunk: vi.fn(),
    markChunkFailed: vi.fn(),
    markChunkUploaded: vi.fn(),
    markBackupAvailable: vi.fn(),
    markBackupFailed: vi.fn(),
    clearBackup: vi.fn(),
    getBackup: vi.fn(),
    buildRecordingBlob: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: studioPageHarness.route.sessionId }),
  usePathname: () => `/studio/${studioPageHarness.route.sessionId}`,
}));

vi.mock("@livekit/components-react", () => {
  // Stable identities defined inside the factory (which runs once, when the
  // mocked module first loads). The real LiveKit hooks memoize these, and
  // studio effects depend on them — returning fresh objects/arrays each render
  // turns those effects into re-render loops once any synchronous setState
  // fires. useRemoteParticipants reads the harness store through
  // useSyncExternalStore: the snapshot is the same array reference until a
  // test replaces it via setRemoteParticipants, so it stays just as stable.
  const localParticipant = {
    localParticipant: {
      republishAllTracks: studioPageHarness.republishAllTracks,
      setMicrophoneEnabled: (enabled: boolean) =>
        studioPageHarness.setMicrophoneEnabled(enabled),
    },
  };
  return {
    LiveKitRoom: ({
      children,
      onConnected,
      audio,
    }: {
      children: ReactNode;
      onConnected?: () => void;
      audio?: unknown;
    }) => {
      studioPageHarness.liveKitAudioProp = audio;
      React.useEffect(() => {
        studioPageHarness.roomOnConnected = onConnected;
        if (studioPageHarness.autoConnectRoom) onConnected?.();
        return () => {
          if (studioPageHarness.roomOnConnected === onConnected) {
            studioPageHarness.roomOnConnected = undefined;
          }
        };
      }, [onConnected]);
      return React.createElement(
        "div",
        { "data-testid": "livekit-room" },
        children,
      );
    },
    RoomAudioRenderer: () => null,
    useConnectionState: () => studioPageHarness.roomConnectionState,
    useRemoteParticipants: () =>
      React.useSyncExternalStore(
        (listener) => {
          studioPageHarness.remoteParticipantsListeners.add(listener);
          return () => {
            studioPageHarness.remoteParticipantsListeners.delete(listener);
          };
        },
        () => studioPageHarness.remoteParticipants,
      ),
    useLocalParticipant: () => localParticipant,
  };
});

vi.mock("@/lib/livekit", () => ({
  LIVEKIT_URL: "ws://livekit.test",
  getToken: studioPageHarness.getToken,
}));

vi.mock("@/lib/transport", () => {
  const transport = {
    sendControlMessage: studioPageHarness.sendControlMessage,
    onControlMessage: studioPageHarness.onControlMessage,
    publishAudio: studioPageHarness.publishAudio,
    unpublishAudio: studioPageHarness.unpublishAudio,
  };
  return {
    useTransport: () => transport,
    isHostSender: studioPageHarness.isHostSender,
    parseParticipantMetadata: () => null,
  };
});

vi.mock("@/lib/recording-state", () => ({
  startRecordingTake: studioPageHarness.startRecordingTake,
  stopRecordingTake: studioPageHarness.stopRecordingTake,
  getRecordingTakeState: studioPageHarness.getRecordingTakeState,
  reportRecordingTakeParticipantStatus:
    studioPageHarness.reportRecordingTakeParticipantStatus,
}));

vi.mock("@/lib/upload", () => ({
  getPresignedUploadTarget: studioPageHarness.getPresignedUploadTarget,
  getPresignedUploadUrl: studioPageHarness.getPresignedUploadUrl,
  uploadChunk: studioPageHarness.uploadChunk,
  completeUpload: studioPageHarness.completeUpload,
}));

vi.mock("@/lib/recorder", () => ({
  CozyRecorder: vi.fn().mockImplementation(function () {
    return {
      onChunk: studioPageHarness.recorderOnChunk,
      start: studioPageHarness.recorderStart,
      stop: studioPageHarness.recorderStop,
    };
  }),
}));

vi.mock("@/lib/recording-sync-marker", () => ({
  createSyncMarkerRecordingStream: (stream: MediaStream) => ({
    stream,
    marker: undefined,
    prepare: studioPageHarness.syncMarkerPrepare,
    playSyncMarker: studioPageHarness.syncMarkerPlay,
    dispose: studioPageHarness.syncMarkerDispose,
  }),
}));

vi.mock("@/lib/audio-downmix", () => ({
  forceMonoStream: (stream: MediaStream) => ({
    stream,
    dispose: vi.fn(),
  }),
  getTrackChannelCount: () => undefined,
}));

vi.mock("@/lib/audio-splitter", () => ({
  splitStereoStream: studioPageHarness.splitStereoStream,
}));

vi.mock("@/lib/monitor-bus", () => ({
  createMonitorBus: studioPageHarness.createMonitorBus,
}));

vi.mock("@/lib/recording-backup", () => ({
  browserRecordingBackupStore: {
    listBackups: studioPageHarness.listBackups,
    ...studioPageHarness.recordingBackupStore,
  },
  recordingBackupId: (sessionId: string, trackId: string) =>
    `${sessionId}:${trackId}`,
}));

vi.mock("@/lib/recording-backup-upload", () => ({
  retryLocalRecordingBackupUpload: (
    ...args: unknown[]
  ) => studioPageHarness.retryLocalRecordingBackupUpload(...args),
}));

vi.mock("@/hooks/useMicMonitor", () => ({
  useMicMonitor: vi.fn(),
}));

vi.mock("@/hooks/useRemoteAudioLevels", () => {
  // Return a *stable* result object. The real hook memoizes its return value;
  // a fresh object each call makes remoteAudio.levels a new identity every
  // render, which turns the studio's remote-levels merge effect into an
  // infinite re-render loop the moment any synchronous setState occurs.
  const stable = {
    levels: new Map<string, number>(),
    clipping: new Set<string>(),
  };
  return { useRemoteAudioLevels: () => stable };
});

vi.mock("@/hooks/useTimingDiagnostics", () => ({
  useTimingDiagnostics: vi.fn(),
}));

vi.mock("@/hooks/useNavigationGuard", () => ({
  useNavigationGuard: (options: { when: boolean; message: string }) =>
    studioPageHarness.navigationGuard(options),
}));

export function mediaStream(): MediaStream {
  const track = {
    stop: vi.fn(),
    getSettings: () => ({}),
  };
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
}

// happy-dom has no Web Audio API, but the studio page's local level monitor
// constructs an AudioContext once the recording stream resolves after join.
// getByteTimeDomainData fills with 128 (silence) so the meter reads 0.
class FakeAudioContext {
  constructor() {
    studioPageHarness.audioContexts.push(this);
  }
  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
  createAnalyser() {
    return {
      fftSize: 2048,
      smoothingTimeConstant: 0,
      getByteTimeDomainData(data: Uint8Array) {
        data.fill(128);
      },
    };
  }
  async close() {}
}

function audioInput(deviceId: string, label: string): MediaDeviceInfo {
  return {
    deviceId,
    label,
    groupId: "group-1",
    kind: "audioinput",
    toJSON() {
      return this;
    },
  } as MediaDeviceInfo;
}

beforeEach(() => {
  studioPageHarness.authMeResponse = { role: "guest", name: "Guest Alice" };
  studioPageHarness.route.sessionId = "session-guest";
  studioPageHarness.remoteParticipants = [];
  studioPageHarness.remoteParticipantsListeners.clear();
  studioPageHarness.navigationGuard.mockClear();
  studioPageHarness.retryLocalRecordingBackupUpload.mockReset();
  studioPageHarness.getToken.mockClear();
  studioPageHarness.sendControlMessage.mockReset().mockResolvedValue(undefined);
  studioPageHarness.onControlMessage.mockReset().mockReturnValue(vi.fn());
  studioPageHarness.isHostSender.mockReset().mockReturnValue(false);
  studioPageHarness.setMicrophoneEnabled.mockReset().mockResolvedValue(undefined);
  studioPageHarness.autoConnectRoom = true;
  studioPageHarness.roomConnectionState = "connected";
  studioPageHarness.roomOnConnected = undefined;
  studioPageHarness.liveKitAudioProp = undefined;
  studioPageHarness.republishAllTracks.mockClear();
  studioPageHarness.publishAudio.mockReset().mockResolvedValue(undefined);
  studioPageHarness.unpublishAudio.mockReset().mockResolvedValue(undefined);
  studioPageHarness.getUserMedia.mockReset().mockResolvedValue(mediaStream());
  studioPageHarness.enumerateDevices
    .mockReset()
    .mockResolvedValue([audioInput("usb-mic", "Shure MV7")]);
  studioPageHarness.listBackups.mockReset().mockResolvedValue([]);
  studioPageHarness.audioContexts.length = 0;
  studioPageHarness.startRecordingTake.mockReset().mockResolvedValue({
    active: true,
    sessionStartedAt: "2026-06-27T12:00:00.000Z",
    take: {
      id: "take-1",
      sessionId: "session-host",
      startedAt: "2026-06-27T12:00:00.000Z",
      stoppedAt: null,
    },
  });
  studioPageHarness.stopRecordingTake.mockReset().mockResolvedValue({
    active: false,
    sessionStartedAt: null,
    take: {
      id: "take-1",
      sessionId: "session-host",
      startedAt: "2026-06-27T12:00:00.000Z",
      stoppedAt: "2026-06-27T12:01:00.000Z",
    },
  });
  // Default: no active take, so the reconnect catch-up effect is a no-op for
  // tests that don't opt in. Reconnect tests override this per case.
  studioPageHarness.getRecordingTakeState.mockReset().mockResolvedValue({
    active: false,
    sessionStartedAt: null,
    take: null,
  });
  studioPageHarness.reportRecordingTakeParticipantStatus
    .mockReset()
    .mockResolvedValue(undefined);
  studioPageHarness.getPresignedUploadTarget.mockReset().mockResolvedValue({
    url: "https://s3.example/0.webm",
    key: "sessions/session-host/tracks/track-1/0.webm",
    recordingToken: "recording-token",
    trackId: "track-1",
    segmentId: "segment-1",
  });
  studioPageHarness.getPresignedUploadUrl
    .mockReset()
    .mockResolvedValue("https://s3.example/recording.webm");
  studioPageHarness.uploadChunk.mockReset().mockResolvedValue(undefined);
  studioPageHarness.completeUpload.mockReset().mockResolvedValue(undefined);
  studioPageHarness.recorderOnChunk.mockReset().mockImplementation((handler) => {
    studioPageHarness.recorderChunkHandler = handler;
  });
  studioPageHarness.recorderStart.mockReset().mockResolvedValue(undefined);
  studioPageHarness.recorderStop
    .mockReset()
    .mockResolvedValue(new Blob(["recording"], { type: "audio/webm" }));
  studioPageHarness.recorderChunkHandler = undefined;
  studioPageHarness.syncMarkerPrepare.mockReset().mockResolvedValue(undefined);
  studioPageHarness.syncMarkerPlay.mockReset().mockResolvedValue(undefined);
  studioPageHarness.syncMarkerDispose.mockReset();
  studioPageHarness.splitterDispose.mockReset();
  studioPageHarness.monitorBusDispose.mockReset();
  studioPageHarness.createMonitorBus.mockReset().mockImplementation(() => ({
    stream: mediaStream(),
    dispose: studioPageHarness.monitorBusDispose,
  }));
  for (const fn of Object.values(studioPageHarness.recordingBackupStore)) {
    // These store methods are async in the real implementation; resolve so
    // chunk-pipeline code that chains .then/.catch on them behaves.
    fn.mockReset().mockResolvedValue(undefined);
  }
  // Default: the split succeeds with two distinct mono channel streams so the
  // two named local slots render and record. Tests that need failure states
  // override this.
  studioPageHarness.splitStereoStream.mockReset().mockImplementation(() => ({
    state: "ok",
    channels: [mediaStream(), mediaStream()],
    dispose: studioPageHarness.splitterDispose,
  }));

  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(studioPageHarness.authMeResponse)),
  );
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
  });

  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: studioPageHarness.getUserMedia,
      enumerateDevices: studioPageHarness.enumerateDevices,
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * Replace the mocked room's remote participant list and notify the
 * useRemoteParticipants subscribers, mirroring a LiveKit join/leave. Call
 * inside act(): `act(() => setRemoteParticipants([...]))`.
 */
export function setRemoteParticipants(
  participants: RemoteParticipantStub[],
): void {
  studioPageHarness.remoteParticipants = participants;
  for (const listener of studioPageHarness.remoteParticipantsListeners) {
    listener();
  }
}

export function renderGuestStudioPage({
  name = "Guest Alice",
  sessionId = "session-guest",
  autoConnectRoom = true,
}: {
  name?: string;
  sessionId?: string;
  autoConnectRoom?: boolean;
} = {}) {
  studioPageHarness.authMeResponse = { role: "guest", name };
  studioPageHarness.route.sessionId = sessionId;
  studioPageHarness.autoConnectRoom = autoConnectRoom;
  studioPageHarness.roomConnectionState = autoConnectRoom
    ? "connected"
    : "connecting";

  const rendered = render(React.createElement(StudioPage));

  return {
    async join() {
      await waitFor(() => {
        screen.getByDisplayValue(name);
      });

      fireEvent.click(screen.getByRole("button", { name: "Join Studio" }));
      await screen.findByTestId("livekit-room");

      // The recording stream resolves asynchronously after the room mounts and
      // spins up the local level monitor. Wait for it so assertions see the
      // settled UI instead of racing the effect against test teardown.
      await waitFor(() => {
        expect(studioPageHarness.audioContexts.length).toBeGreaterThan(0);
      });
    },
    connectRoom() {
      const onConnected = studioPageHarness.roomOnConnected;
      act(() => {
        studioPageHarness.roomConnectionState = "connected";
        onConnected?.();
        rendered.rerender(React.createElement(StudioPage));
      });
    },
    setRoomConnectionState(next: MockRoomConnectionState) {
      act(() => {
        studioPageHarness.roomConnectionState = next;
        rendered.rerender(React.createElement(StudioPage));
      });
    },
    screen,
    harness: studioPageHarness,
  };
}

export function renderHostStudioPage({
  name = "Pasha",
  sessionId = "session-host",
  autoConnectRoom = true,
}: {
  name?: string;
  sessionId?: string;
  autoConnectRoom?: boolean;
} = {}) {
  studioPageHarness.authMeResponse = { role: "host" };
  studioPageHarness.route.sessionId = sessionId;
  studioPageHarness.autoConnectRoom = autoConnectRoom;
  studioPageHarness.roomConnectionState = autoConnectRoom
    ? "connected"
    : "connecting";

  const rendered = render(React.createElement(StudioPage));

  return {
    async join() {
      const nameInput = await screen.findByPlaceholderText("Enter your name");
      fireEvent.change(nameInput, { target: { value: name } });

      fireEvent.click(screen.getByRole("button", { name: "Join Studio" }));
      await screen.findByTestId("livekit-room");

      await waitFor(() => {
        expect(studioPageHarness.audioContexts.length).toBeGreaterThan(0);
      });
    },
    connectRoom() {
      const onConnected = studioPageHarness.roomOnConnected;
      act(() => {
        studioPageHarness.roomConnectionState = "connected";
        onConnected?.();
        rendered.rerender(React.createElement(StudioPage));
      });
    },
    setRoomConnectionState(next: MockRoomConnectionState) {
      act(() => {
        studioPageHarness.roomConnectionState = next;
        rendered.rerender(React.createElement(StudioPage));
      });
    },
    screen,
    harness: studioPageHarness,
  };
}
