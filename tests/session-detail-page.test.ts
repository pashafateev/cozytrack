import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SessionDetailPage from "@/app/session/[id]/page";
import { downloadTracksZip } from "@/lib/download-tracks";

vi.mock("@/lib/download-tracks", () => ({
  downloadTracksZip: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "68eca386-21c3-4bf8-a013-2d5db48d3376" }),
  usePathname: () => "/session/68eca386-21c3-4bf8-a013-2d5db48d3376",
}));

const sessionId = "68eca386-21c3-4bf8-a013-2d5db48d3376";
const command = "pod ct-ingest 68eca386-21c3-4bf8-a013-2d5db48d3376";
const savedSession = {
  id: sessionId,
  name: "Saved recording",
  status: "ready",
  finalizedAt: "2026-10-24T10:01:00.000Z",
  createdAt: "2026-10-24T10:00:00.000Z",
  updatedAt: "2026-10-24T10:01:00.000Z",
  tracks: [{
    id: "track-1",
    sessionId,
    takeId: "take-1",
    participantName: "Host",
    participantId: "host",
    s3Key: `sessions/${sessionId}/tracks/track-1/recording.webm`,
    durationMs: 60_000,
    format: "webm",
    status: "complete",
    s3PurgedAt: null,
    deviceLabel: "External microphone",
    deviceId: "microphone-1",
    isBuiltInMic: false,
    sessionStartedAt: "2026-10-24T10:00:00.000Z",
    partial: false,
    createdAt: "2026-10-24T10:00:00.000Z",
    updatedAt: "2026-10-24T10:01:00.000Z",
  }],
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
let writeClipboard: ReturnType<typeof vi.fn<(data: string) => Promise<void>>>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(response(savedSession));
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(downloadTracksZip).mockReset().mockResolvedValue(undefined);
  writeClipboard = vi.fn<(data: string) => Promise<void>>().mockResolvedValue(undefined);
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation(writeClipboard);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("saved session ingest command", () => {
  it("restores the full command from the saved session when the page is reopened", async () => {
    const firstVisit = render(React.createElement(SessionDetailPage));
    expect(await screen.findByText(command)).toBeTruthy();
    firstVisit.unmount();

    fetchMock.mockResolvedValueOnce(response({
      ...savedSession,
      name: "Renamed saved recording",
    }));
    render(React.createElement(SessionDetailPage));

    expect(await screen.findByRole("heading", { name: "Renamed saved recording" })).toBeTruthy();
    expect(screen.getByText(command)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));

    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(writeClipboard).toHaveBeenCalledWith(command);
    // Reopening and copying only read session metadata: no finalization or
    // track-download request should be initiated by this command panel.
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"]))
      .toEqual([
        [`/api/sessions/${sessionId}`, "GET"],
        [`/api/sessions/${sessionId}`, "GET"],
      ]);
  });

  it("keeps the full command available for manual copying when clipboard access fails", async () => {
    writeClipboard.mockRejectedValueOnce(new Error("Clipboard permission denied"));
    render(React.createElement(SessionDetailPage));
    await screen.findByText(command);

    fireEvent.click(screen.getByRole("button", { name: /copy/i }));

    expect((await screen.findByRole("status")).textContent).toMatch(/select and copy the command/i);
    expect(writeClipboard).toHaveBeenCalledWith(command);
    expect(screen.getByText(command)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^copied$/i })).toBeNull();
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"]))
      .toEqual([[`/api/sessions/${sessionId}`, "GET"]]);
  });

  it("lets keyboard users select the full command for manual copying", async () => {
    render(React.createElement(SessionDetailPage));
    const field = await screen.findByRole("textbox", { name: "Podline ingest command" });
    const textarea = field as HTMLTextAreaElement;

    field.focus();

    expect(textarea.readOnly).toBe(true);
    expect(textarea.value).toBe(command);
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.selectionEnd).toBe(command.length);
  });

  it.each([
    { label: "pending", sessionStatus: "recording", trackStatus: "uploading", purgedAt: null },
    { label: "failed", sessionStatus: "ready", trackStatus: "failed", purgedAt: null },
    { label: "purged", sessionStatus: "ready", trackStatus: "complete", purgedAt: "2026-10-24T11:00:00.000Z" },
  ])("keeps the command available for an existing $label session", async ({ sessionStatus, trackStatus, purgedAt }) => {
    fetchMock.mockResolvedValueOnce(response({
      ...savedSession,
      status: sessionStatus,
      finalizedAt: sessionStatus === "ready" ? savedSession.finalizedAt : null,
      tracks: [{ ...savedSession.tracks[0], status: trackStatus, s3PurgedAt: purgedAt }],
    }));
    render(React.createElement(SessionDetailPage));

    expect(await screen.findByText(command)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(writeClipboard).toHaveBeenCalledWith(command);
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"]))
      .toEqual([[`/api/sessions/${sessionId}`, "GET"]]);
  });

  it("does not offer an ingest command for a missing session", async () => {
    fetchMock.mockResolvedValueOnce(response({ error: "Session not found" }, 404));
    render(React.createElement(SessionDetailPage));

    expect(await screen.findByText("Session not found")).toBeTruthy();
    expect(screen.queryByText(/pod ct-ingest/)).toBeNull();
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
  });
});

describe("saved session bulk download", () => {
  it("downloads the session's available tracks as one ZIP", async () => {
    render(React.createElement(SessionDetailPage));
    const button = await screen.findByRole("button", { name: "Download All Tracks" });
    expect((button as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(button);

    await waitFor(() => {
      expect(downloadTracksZip).toHaveBeenCalledWith({
        sessionId,
        sessionName: "Saved recording",
        tracks: [{ id: "track-1", participantName: "Host", format: "webm" }],
      }, { signal: expect.any(AbortSignal) });
      expect(screen.queryByRole("button", { name: "Preparing ZIP…" })).toBeNull();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("excludes unavailable tracks and explains a partial ZIP", async () => {
    fetchMock.mockResolvedValueOnce(response({
      ...savedSession,
      tracks: [
        savedSession.tracks[0],
        { ...savedSession.tracks[0], id: "uploading", status: "uploading" },
        { ...savedSession.tracks[0], id: "recording", status: "recording" },
        { ...savedSession.tracks[0], id: "failed", status: "failed" },
        { ...savedSession.tracks[0], id: "purged", s3PurgedAt: "2026-10-24T11:00:00.000Z" },
        { ...savedSession.tracks[0], id: "missing", s3Key: "" },
      ],
    }));
    render(React.createElement(SessionDetailPage));
    fireEvent.click(await screen.findByRole("button", { name: "Download All Tracks" }));

    expect(screen.getByText(/ZIP includes 1 of 6 tracks/)).toBeTruthy();
    await waitFor(() => {
      expect(downloadTracksZip).toHaveBeenCalledWith(
        expect.objectContaining({
          tracks: [{ id: "track-1", participantName: "Host", format: "webm" }],
        }),
        expect.anything(),
      );
    });
  });

  it.each([
    { label: "empty", tracks: [] },
    { label: "incomplete", tracks: [{ ...savedSession.tracks[0], status: "uploading" }] },
    { label: "purged", tracks: [{ ...savedSession.tracks[0], s3PurgedAt: "2026-10-24T11:00:00.000Z" }] },
    { label: "missing", tracks: [{ ...savedSession.tracks[0], s3Key: "" }] },
  ])("disables bulk download for an $label session", async ({ tracks }) => {
    fetchMock.mockResolvedValueOnce(response({ ...savedSession, tracks }));
    render(React.createElement(SessionDetailPage));
    const button = await screen.findByRole("button", { name: "Download All Tracks" });

    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("No completed tracks are available to download.")).toBeTruthy();
    fireEvent.click(button);
    expect(downloadTracksZip).not.toHaveBeenCalled();
  });

  it("prevents overlapping downloads and lets the host retry a failure", async () => {
    let rejectDownload!: (error: Error) => void;
    vi.mocked(downloadTracksZip).mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => { rejectDownload = reject; }),
    );
    render(React.createElement(SessionDetailPage));
    fireEvent.click(await screen.findByRole("button", { name: "Download All Tracks" }));
    const pending = screen.getByRole("button", { name: "Preparing ZIP…" });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toMatch(/keep this page open/i);
    fireEvent.click(pending);
    expect(downloadTracksZip).toHaveBeenCalledTimes(1);

    await act(async () => rejectDownload(new Error("private signed URL")));
    expect(screen.getByRole("alert").textContent).toMatch(/could not download all tracks/i);
    expect(screen.queryByText(/private signed URL/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download All Tracks" }));

    await waitFor(() => {
      expect(downloadTracksZip).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  it("cancels the active download when the session page is closed", async () => {
    vi.mocked(downloadTracksZip).mockReturnValueOnce(new Promise<void>(() => {}));
    const page = render(React.createElement(SessionDetailPage));
    fireEvent.click(await screen.findByRole("button", { name: "Download All Tracks" }));
    const signal = vi.mocked(downloadTracksZip).mock.calls[0][1]?.signal;

    expect(signal?.aborted).toBe(false);
    page.unmount();
    expect(signal?.aborted).toBe(true);
  });
});
