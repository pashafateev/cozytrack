import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  renderGuestStudioPage,
  renderHostStudioPage,
} from "./helpers/studio-page";

function backupManifest(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-host:track-1",
    sessionId: "session-host",
    trackId: "track-1",
    segmentId: "segment-1",
    participantName: "Pasha",
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    state: "failed",
    persistentStorage: true,
    chunks: [{ index: 0, byteSize: 5, uploadStatus: "failed" }],
    ...overrides,
  };
}

const RECORDING_MESSAGE =
  "Recording is in progress and may be lost if you leave. Leave anyway?";
const UPLOADING_MESSAGE =
  "Your audio hasn't finished uploading and may be lost if you leave. Leave anyway?";

function lastGuardCall(harness: {
  navigationGuard: { mock: { calls: unknown[][] } };
}): { when: boolean; message: string } {
  const calls = harness.navigationGuard.mock.calls;
  return calls[calls.length - 1][0] as { when: boolean; message: string };
}

describe("StudioPage exit guard", () => {
  it("uses the recording wording while a take is active", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Start recording" }),
    );
    await studio.screen.findByRole("button", { name: "Stop recording" });

    const guard = lastGuardCall(studio.harness);
    expect(guard.when).toBe(true);
    expect(guard.message).toBe(RECORDING_MESSAGE);
  });

  it("disarms after a clean stop and shows the all-clear", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Start recording" }),
    );
    await studio.screen.findByRole("button", { name: "Stop recording" });
    fireEvent.click(
      studio.screen.getByRole("button", { name: "Stop recording" }),
    );
    await studio.screen.findByRole("button", { name: "Start recording" });

    expect(await studio.screen.findByText("All audio uploaded")).toBeTruthy();
    const guard = lastGuardCall(studio.harness);
    expect(guard.when).toBe(false);
  });

  it("stays armed with upload wording when a track fails to complete", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Start recording" }),
    );
    await studio.screen.findByRole("button", { name: "Stop recording" });

    // Fail the server-side completion: the slot never confirms, the lifecycle
    // keeps the local backup (marked failed), and the page must keep the exit
    // guard armed off that surfaced state.
    studio.harness.completeUpload.mockRejectedValue(
      new Error("complete failed"),
    );
    studio.harness.recordingBackupStore.markBackupFailed.mockResolvedValue({
      id: "session-host:track-1",
      sessionId: "session-host",
      trackId: "track-1",
      segmentId: "segment-1",
      participantName: "Pasha",
      state: "failed",
      chunks: [{ index: 0, byteSize: 5, uploadStatus: "failed" }],
    });

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Stop recording" }),
    );
    await studio.screen.findByRole("button", { name: "Start recording" });

    await waitFor(() => {
      const guard = lastGuardCall(studio.harness);
      expect(guard.when).toBe(true);
      expect(guard.message).toBe(UPLOADING_MESSAGE);
    });
    expect(studio.screen.queryByText("All audio uploaded")).toBeNull();
  });

  it("tells guests it is safe to close the tab once uploads confirm", async () => {
    const studio = renderGuestStudioPage();
    await studio.join();

    studio.harness.isHostSenderResult = true;
    const handlers = (
      studio.harness.onControlMessage.mock.calls as unknown as Array<
        [(message: unknown, sender: unknown) => void]
      >
    ).map((call) => call[0]);
    const sender = { identity: "host", metadata: "host-metadata" };

    for (const handler of handlers) {
      handler(
        {
          type: "recording_start",
          sessionStartedAt: "2026-07-12T10:00:00.000Z",
          takeId: "take-1",
        },
        sender,
      );
    }
    await waitFor(() => {
      expect(studio.harness.recorderStart).toHaveBeenCalled();
    });

    for (const handler of handlers) {
      handler({ type: "recording_stop" }, sender);
    }
    await waitFor(() => {
      expect(studio.harness.completeUpload).toHaveBeenCalled();
    });

    expect(
      await studio.screen.findByText(
        "All audio uploaded — safe to close this tab",
      ),
    ).toBeTruthy();
  });

  it("does not arm when listing local backups fails at mount", async () => {
    const studio = renderHostStudioPage();
    // Once, not permanent: the helper's beforeEach only mockClear()s this
    // shared mock, so a persistent rejection would leak into later tests.
    studio.harness.listBackups.mockRejectedValueOnce(new Error("idb wedged"));

    await studio.join();
    await waitFor(() => {
      expect(studio.harness.listBackups).toHaveBeenCalled();
    });

    expect(lastGuardCall(studio.harness).when).toBe(false);
  });

  it("stays disarmed and shows the all-clear when only verified-backup cleanup fails", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

    // The track confirms server-side; only the local IndexedDB cleanup fails.
    studio.harness.recordingBackupStore.startBackup.mockResolvedValue(
      backupManifest({ state: "recording", chunks: [] }),
    );
    studio.harness.recordingBackupStore.clearBackup.mockRejectedValue(
      new Error("idb wedged"),
    );

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Start recording" }),
    );
    await studio.screen.findByRole("button", { name: "Stop recording" });
    fireEvent.click(
      studio.screen.getByRole("button", { name: "Stop recording" }),
    );
    await studio.screen.findByRole("button", { name: "Start recording" });

    expect(await studio.screen.findByText("All audio uploaded")).toBeTruthy();
    expect(lastGuardCall(studio.harness).when).toBe(false);
  });

  it("disarms and shows the all-clear after a successful backup retry", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

    studio.harness.completeUpload.mockRejectedValue(
      new Error("complete failed"),
    );
    studio.harness.recordingBackupStore.startBackup.mockResolvedValue(
      backupManifest({ state: "recording", chunks: [] }),
    );
    studio.harness.recordingBackupStore.markBackupFailed.mockResolvedValue(
      backupManifest(),
    );
    studio.harness.recordingBackupStore.getBackup.mockResolvedValue(
      backupManifest(),
    );

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Start recording" }),
    );
    await studio.screen.findByRole("button", { name: "Stop recording" });
    fireEvent.click(
      studio.screen.getByRole("button", { name: "Stop recording" }),
    );
    await studio.screen.findByRole("button", { name: "Start recording" });

    await waitFor(() => {
      expect(lastGuardCall(studio.harness).when).toBe(true);
    });

    studio.harness.retryLocalRecordingBackupUpload.mockResolvedValue(
      backupManifest({ state: "uploaded" }),
    );

    fireEvent.click(
      await studio.screen.findByRole("button", { name: "Retry upload" }),
    );
    await waitFor(() => {
      expect(studio.harness.retryLocalRecordingBackupUpload).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(lastGuardCall(studio.harness).when).toBe(false);
    });
    expect(await studio.screen.findByText("All audio uploaded")).toBeTruthy();
  });
});
