import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderGuestStudioPage, renderHostStudioPage } from "./helpers/studio-page";
import SessionDetailPage from "@/app/session/[id]/page";
import { UploadDiagnosticsDownload } from "@/components/UploadDiagnosticsDownload";
import { browserRecordingBackupStore, type RecordingBackupManifest } from "@/lib/recording-backup";
import { retryLocalRecordingBackupUpload } from "@/lib/recording-backup-upload";

const diagnostics = vi.hoisted(() => ({
  download: vi.fn<(sessionId: string) => Promise<void>>(),
  record: vi.fn(),
}));

// File generation and the browser download are covered by the journal tests.
// Here the boundary lets us exercise page access and asynchronous UI failures.
vi.mock("@/lib/upload-diagnostics", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/upload-diagnostics")>(),
  downloadUploadDiagnostics: diagnostics.download,
  recordUploadDiagnostic: diagnostics.record,
}));

beforeEach(() => {
  diagnostics.download.mockReset().mockResolvedValue(undefined);
  diagnostics.record.mockReset();
  vi.mocked(retryLocalRecordingBackupUpload).mockReset();
});

describe("upload diagnostics download access", () => {
  it("lets the host export the current session without a local audio backup", async () => {
    const studio = renderHostStudioPage({ sessionId: "session-host-export" });
    await studio.join();
    expect(screen.queryByText("Local recording backup")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(screen.getByRole("button", { name: "Download diagnostics" }));

    await waitFor(() => {
      expect(diagnostics.download).toHaveBeenCalledWith("session-host-export");
    });
  });

  it("lets guests export only their current session's browser diagnostics", async () => {
    const studio = renderGuestStudioPage({ sessionId: "session-guest-export" });
    await studio.join();

    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(screen.getByRole("button", { name: "Download diagnostics" }));

    await waitFor(() => {
      expect(diagnostics.download).toHaveBeenCalledWith("session-guest-export");
    });
  });

  it("keeps diagnostics available on the finished session page", async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({
        id: "session-guest",
        name: "Finished recording",
        status: "ready",
        createdAt: "2026-10-17T12:00:00.000Z",
        tracks: [],
      }),
    );
    render(React.createElement(SessionDetailPage));

    fireEvent.click(await screen.findByRole("button", { name: "Download diagnostics" }));

    await waitFor(() => {
      expect(diagnostics.download).toHaveBeenCalledWith("session-guest");
    });
  });

  it("prevents overlapping exports and allows retry after a safe error", async () => {
    let rejectDownload!: (reason: Error) => void;
    diagnostics.download.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => { rejectDownload = reject; }),
    );
    render(React.createElement(UploadDiagnosticsDownload, { sessionId: "session-guest" }));
    fireEvent.click(screen.getByRole("button", { name: "Download diagnostics" }));

    const pending = screen.getByRole("button", { name: "Preparing diagnostics…" }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    fireEvent.click(pending);
    expect(diagnostics.download).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectDownload(new Error("private storage failure details"));
    });
    expect(screen.getByRole("alert").textContent).toMatch(/diagnostics.*unavailable/i);
    expect(screen.queryByText(/private storage failure details/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Download diagnostics" }));
    await waitFor(() => {
      expect(diagnostics.download).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});

describe("manual backup retry diagnostics", () => {
  const backup: RecordingBackupManifest = {
    id: "session-host:segment-retry",
    sessionId: "session-host",
    trackId: "track-retry",
    segmentId: "segment-retry",
    participantName: "Pasha",
    createdAt: "2026-10-17T12:00:00.000Z",
    updatedAt: "2026-10-17T12:00:01.000Z",
    state: "failed",
    persistentStorage: true,
    recordingToken: "retry-token",
    durationMs: 1000,
    chunks: [{
      chunkIndex: 0,
      byteSize: 100,
      capturedAt: "2026-10-17T12:00:00.000Z",
      uploadStatus: "failed",
      storage: "indexeddb",
      storageKey: "chunk-retry-0",
    }],
  };

  async function renderBackup() {
    vi.mocked(browserRecordingBackupStore.listBackups).mockResolvedValueOnce([backup]);
    vi.mocked(browserRecordingBackupStore.getBackup).mockResolvedValue(backup);
    const studio = renderHostStudioPage();
    await studio.join();
    await screen.findByText("Local recording backup");
    return studio;
  }

  it("correlates retry and cleanup only after the local backup has cleared", async () => {
    vi.mocked(retryLocalRecordingBackupUpload).mockResolvedValue({ ...backup, state: "available" });
    let finishClear!: () => void;
    vi.mocked(browserRecordingBackupStore.clearBackup).mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishClear = resolve; }),
    );
    await renderBackup();

    fireEvent.click(screen.getByRole("button", { name: "Retry upload" }));
    await waitFor(() => {
      expect(retryLocalRecordingBackupUpload).toHaveBeenCalledWith(backup, {
        diagnosticContext: expect.objectContaining({
          attemptId: expect.any(String),
          sessionId: "session-host",
          trackId: "track-retry",
          segmentId: "segment-retry",
          kind: "retry",
          recordingToken: "retry-token",
        }),
      });
    });
    expect(diagnostics.record).not.toHaveBeenCalledWith(expect.anything(), {
      stage: "backup", outcome: "cleared",
    });

    act(() => { finishClear(); });
    await waitFor(() => {
      const retryOptions = vi.mocked(retryLocalRecordingBackupUpload).mock.calls[0][1];
      expect(diagnostics.record).toHaveBeenCalledWith(retryOptions?.diagnosticContext, {
        stage: "backup", outcome: "cleared",
      });
      expect(screen.queryByText("Local recording backup")).toBeNull();
    });
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(screen.getByRole("button", { name: "Download diagnostics" }));
    await waitFor(() => expect(diagnostics.download).toHaveBeenCalledWith("session-host"));
  });

  it("retains the audio backup and records the same retry attempt on failure", async () => {
    vi.mocked(retryLocalRecordingBackupUpload).mockRejectedValue(new TypeError("Failed to fetch"));
    await renderBackup();

    fireEvent.click(screen.getByRole("button", { name: "Retry upload" }));
    await screen.findByText("Retry failed - local backup kept");

    expect(browserRecordingBackupStore.clearBackup).not.toHaveBeenCalled();
    const retryOptions = vi.mocked(retryLocalRecordingBackupUpload).mock.calls[0][1];
    expect(diagnostics.record).toHaveBeenCalledWith(retryOptions?.diagnosticContext, {
      stage: "backup", outcome: "retained",
    });
    expect(screen.getByText("Local recording backup")).toBeTruthy();
  });
});
