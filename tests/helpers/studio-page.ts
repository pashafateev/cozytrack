import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, vi } from "vitest";
import StudioPage from "@/app/studio/[id]/page";

type AuthMeResponse =
  | { role: "guest"; name: string }
  | { role: "host" };

const studioPageHarness = vi.hoisted(() => ({
  authMeResponse: { role: "guest", name: "Guest Alice" } as AuthMeResponse,
  route: {
    sessionId: "session-guest",
  },
  getToken: vi.fn(async () => "livekit-token"),
  sendControlMessage: vi.fn(async () => undefined),
  onControlMessage: vi.fn(() => vi.fn()),
  republishAllTracks: vi.fn(async () => undefined),
  getUserMedia: vi.fn(),
  enumerateDevices: vi.fn(),
  listBackups: vi.fn(async () => []),
  startRecordingTake: vi.fn(),
  stopRecordingTake: vi.fn(async () => undefined),
  reportRecordingTakeParticipantStatus: vi.fn(async () => undefined),
  getPresignedUploadTarget: vi.fn(),
  getPresignedUploadUrl: vi.fn(async () => "https://upload.example/chunk"),
  uploadChunk: vi.fn(async () => undefined),
  completeUpload: vi.fn(async () => undefined),
  recorderConstructedStreams: [] as MediaStream[],
  recorderOnChunkCallbacks: [] as Array<(chunk: Blob, index: number) => void>,
  recorderStart: vi.fn(async (_timeSlice?: number) => undefined),
  recorderStop: vi.fn(async () => new Blob([], { type: "audio/webm" })),
  markerStream: null as MediaStream | null,
  createSyncMarkerRecordingStream: vi.fn(),
  audioContexts: [] as unknown[],
}));

export const studioPageTestHarness = studioPageHarness;

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: studioPageHarness.route.sessionId }),
  usePathname: () => `/studio/${studioPageHarness.route.sessionId}`,
}));

vi.mock("@livekit/components-react", () => ({
  LiveKitRoom: ({ children }: { children: ReactNode }) =>
    React.createElement("div", { "data-testid": "livekit-room" }, children),
  RoomAudioRenderer: () => null,
  useRemoteParticipants: () => [],
  useLocalParticipant: () => ({
    localParticipant: {
      republishAllTracks: studioPageHarness.republishAllTracks,
    },
  }),
}));

vi.mock("@/lib/livekit", () => ({
  LIVEKIT_URL: "ws://livekit.test",
  getToken: studioPageHarness.getToken,
}));

vi.mock("@/lib/transport", () => ({
  useTransport: () => ({
    sendControlMessage: studioPageHarness.sendControlMessage,
    onControlMessage: studioPageHarness.onControlMessage,
  }),
  isHostSender: () => false,
  parseParticipantMetadata: () => null,
}));

vi.mock("@/lib/recording-state", () => ({
  startRecordingTake: studioPageHarness.startRecordingTake,
  stopRecordingTake: studioPageHarness.stopRecordingTake,
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
  CozyRecorder: class FakeCozyRecorder {
    constructor(stream: MediaStream) {
      studioPageHarness.recorderConstructedStreams.push(stream);
    }

    onChunk(callback: (chunk: Blob, index: number) => void) {
      studioPageHarness.recorderOnChunkCallbacks.push(callback);
    }

    start(timeSlice?: number) {
      return studioPageHarness.recorderStart(timeSlice);
    }

    stop() {
      return studioPageHarness.recorderStop();
    }
  },
}));

vi.mock("@/lib/recording-sync-marker", () => ({
  createSyncMarkerRecordingStream:
    studioPageHarness.createSyncMarkerRecordingStream,
}));

vi.mock("@/lib/audio-downmix", () => ({
  forceMonoStream: (stream: MediaStream) => ({
    stream,
    dispose: vi.fn(),
  }),
  getTrackChannelCount: () => undefined,
}));

vi.mock("@/lib/recording-backup", () => ({
  browserRecordingBackupStore: {
    listBackups: studioPageHarness.listBackups,
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
  recordingBackupId: (sessionId: string, trackId: string) =>
    `${sessionId}:${trackId}`,
}));

vi.mock("@/lib/recording-backup-upload", () => ({
  retryLocalRecordingBackupUpload: vi.fn(),
}));

vi.mock("@/hooks/useMicMonitor", () => ({
  useMicMonitor: vi.fn(),
}));

vi.mock("@/hooks/useRemoteAudioLevels", () => ({
  useRemoteAudioLevels: () => ({
    levels: new Map<string, number>(),
    clipping: new Set<string>(),
  }),
}));

vi.mock("@/hooks/useTimingDiagnostics", () => ({
  useTimingDiagnostics: vi.fn(),
}));

vi.mock("@/hooks/useNavigationGuard", () => ({
  useNavigationGuard: vi.fn(),
}));

function mediaStream(): MediaStream {
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
  studioPageHarness.getToken.mockClear();
  studioPageHarness.sendControlMessage.mockClear();
  studioPageHarness.onControlMessage.mockReset().mockReturnValue(vi.fn());
  studioPageHarness.republishAllTracks.mockClear();
  studioPageHarness.getUserMedia.mockReset().mockResolvedValue(mediaStream());
  studioPageHarness.enumerateDevices
    .mockReset()
    .mockResolvedValue([audioInput("usb-mic", "Shure MV7")]);
  studioPageHarness.listBackups.mockClear();
  studioPageHarness.startRecordingTake
    .mockReset()
    .mockImplementation(async (_sessionId: string, sessionStartedAt: string) => ({
      sessionStartedAt,
      take: { id: "take-1" },
    }));
  studioPageHarness.stopRecordingTake.mockClear();
  studioPageHarness.reportRecordingTakeParticipantStatus.mockClear();
  studioPageHarness.getPresignedUploadTarget
    .mockReset()
    .mockResolvedValue({
      url: "https://upload.example/chunk-0",
      recordingToken: "recording-token",
      trackId: "track-1",
      segmentId: "segment-1",
    });
  studioPageHarness.getPresignedUploadUrl.mockClear();
  studioPageHarness.uploadChunk.mockClear();
  studioPageHarness.completeUpload.mockClear();
  studioPageHarness.recorderConstructedStreams.length = 0;
  studioPageHarness.recorderOnChunkCallbacks.length = 0;
  studioPageHarness.recorderStart.mockClear();
  studioPageHarness.recorderStop.mockClear();
  studioPageHarness.markerStream = mediaStream();
  studioPageHarness.createSyncMarkerRecordingStream
    .mockReset()
    .mockImplementation(() => {
      const marker = { version: "test-marker", offsetMs: 100, durationMs: 300 };
      return {
        stream: studioPageHarness.markerStream,
        marker,
        prepare: vi.fn(async () => marker),
        playSyncMarker: vi.fn(async () => marker),
        dispose: vi.fn(),
      };
    });
  studioPageHarness.audioContexts.length = 0;

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

export function renderGuestStudioPage({
  name = "Guest Alice",
  sessionId = "session-guest",
}: {
  name?: string;
  sessionId?: string;
} = {}) {
  studioPageHarness.authMeResponse = { role: "guest", name };
  studioPageHarness.route.sessionId = sessionId;

  render(React.createElement(StudioPage));

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
    screen,
  };
}

export function renderHostStudioPage({
  name = "Host Pasha",
  sessionId = "session-host",
}: {
  name?: string;
  sessionId?: string;
} = {}) {
  studioPageHarness.authMeResponse = { role: "host" };
  studioPageHarness.route.sessionId = sessionId;

  render(React.createElement(StudioPage));

  return {
    async join() {
      const nameInput = await screen.findByPlaceholderText("Enter your name");
      fireEvent.change(nameInput, { target: { value: name } });

      await waitFor(() => {
        const joinButton = screen.getByRole("button", {
          name: "Join Studio",
        }) as HTMLButtonElement;
        expect(joinButton.disabled).toBe(false);
      });

      fireEvent.click(screen.getByRole("button", { name: "Join Studio" }));
      await screen.findByTestId("livekit-room");

      await waitFor(() => {
        expect(studioPageHarness.audioContexts.length).toBeGreaterThan(0);
      });
    },
    async startRecording() {
      fireEvent.click(
        screen.getByRole("button", { name: "Start recording" }),
      );

      await waitFor(() => {
        expect(studioPageHarness.recorderStart).toHaveBeenCalled();
      });
    },
    screen,
  };
}
