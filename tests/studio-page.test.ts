import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StudioPage from "@/app/studio/[id]/page";

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(async () => "livekit-token"),
  republishAllTracks: vi.fn(async () => undefined),
  getUserMedia: vi.fn(),
  enumerateDevices: vi.fn(),
  listBackups: vi.fn(async () => []),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "session-guest" }),
  usePathname: () => "/studio/session-guest",
}));

vi.mock("@livekit/components-react", () => ({
  LiveKitRoom: ({ children }: { children: ReactNode }) =>
    React.createElement("div", { "data-testid": "livekit-room" }, children),
  RoomAudioRenderer: () => null,
  useRemoteParticipants: () => [],
  useLocalParticipant: () => ({
    localParticipant: {
      republishAllTracks: mocks.republishAllTracks,
    },
  }),
}));

vi.mock("@/lib/livekit", () => ({
  LIVEKIT_URL: "ws://livekit.test",
  getToken: mocks.getToken,
}));

vi.mock("@/lib/transport", () => ({
  useTransport: () => ({
    sendControlMessage: vi.fn(async () => undefined),
    onControlMessage: vi.fn(() => vi.fn()),
  }),
  isHostSender: () => false,
  parseParticipantMetadata: () => null,
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
    listBackups: mocks.listBackups,
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

function audioInput(
  deviceId: string,
  label: string,
): MediaDeviceInfo {
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
  mocks.getToken.mockClear();
  mocks.republishAllTracks.mockClear();
  mocks.getUserMedia.mockReset().mockResolvedValue(mediaStream());
  mocks.enumerateDevices
    .mockReset()
    .mockResolvedValue([audioInput("usb-mic", "Shure MV7")]);
  mocks.listBackups.mockClear();

  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ role: "guest", name: "Guest Alice" }),
    ),
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
      getUserMedia: mocks.getUserMedia,
      enumerateDevices: mocks.enumerateDevices,
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("StudioPage participant role labels", () => {
  it("does not label the local participant as host when a guest joins", async () => {
    render(React.createElement(StudioPage));

    await waitFor(() => {
      expect(screen.getByDisplayValue("Guest Alice")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Join Studio" }));

    await screen.findByTestId("livekit-room");

    expect(screen.getByText("Guest Alice")).toBeTruthy();
    expect(screen.queryByText("host")).toBeNull();
  });
});
