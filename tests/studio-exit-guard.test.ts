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

    studio.harness.isHostSender.mockReturnValue(true);
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

  it("arms when a partial two-channel start rolls back but a backup is kept", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

    fireEvent.click(
      studio.screen.getByRole("checkbox", { name: /two-channel local/i }),
    );
    await studio.screen.findByText("Local Ch 1");

    // Channel 1 starts; channel 2's presign fails, forcing rollback of the
    // started slot. Its rollback finalization also fails (completeUpload),
    // so a recoverable backup is kept — the guard must arm.
    studio.harness.getPresignedUploadTarget.mockImplementation(
      async (
        _sessionId: string,
        _trackId: string,
        _part: number,
        _name: string,
        init?: { localTrackSlotId?: string },
      ) => {
        if (init?.localTrackSlotId === "host-local-ch-2") {
          throw new Error("presign failed");
        }
        return {
          url: "https://s3.example/0.webm",
          key: "sessions/session-host/tracks/x/0.webm",
          recordingToken: "token-ch1",
          trackId: "track-ch1",
          segmentId: "segment-ch1",
        };
      },
    );
    studio.harness.recordingBackupStore.startBackup.mockResolvedValue(
      backupManifest({ state: "recording", chunks: [] }),
    );
    studio.harness.completeUpload.mockRejectedValue(
      new Error("complete failed"),
    );
    studio.harness.recordingBackupStore.markBackupFailed.mockResolvedValue(
      backupManifest(),
    );

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Start recording" }),
    );

    await waitFor(() => {
      const guard = lastGuardCall(studio.harness);
      expect(guard.when).toBe(true);
      expect(guard.message).toBe(UPLOADING_MESSAGE);
    });
    // The failed start never entered recording.
    expect(
      studio.screen.getByRole("button", { name: "Start recording" }),
    ).toBeTruthy();
  });

  it("stays disarmed when a partial start's rollback cleans up fully", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

    fireEvent.click(
      studio.screen.getByRole("checkbox", { name: /two-channel local/i }),
    );
    await studio.screen.findByText("Local Ch 1");

    studio.harness.getPresignedUploadTarget.mockImplementation(
      async (
        _sessionId: string,
        _trackId: string,
        _part: number,
        _name: string,
        init?: { localTrackSlotId?: string },
      ) => {
        if (init?.localTrackSlotId === "host-local-ch-2") {
          throw new Error("presign failed");
        }
        return {
          url: "https://s3.example/0.webm",
          key: "sessions/session-host/tracks/x/0.webm",
          recordingToken: "token-ch1",
          trackId: "track-ch1",
          segmentId: "segment-ch1",
        };
      },
    );
    studio.harness.recordingBackupStore.startBackup.mockResolvedValue(
      backupManifest({ state: "recording", chunks: [] }),
    );

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Start recording" }),
    );

    // Rollback finalizes channel 1 cleanly (complete + clearBackup succeed).
    await waitFor(() => {
      expect(studio.harness.completeUpload).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(lastGuardCall(studio.harness).when).toBe(false);
    });
  });

  it("arms during recorder startup, before start() resolves", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

    fireEvent.click(
      studio.screen.getByRole("checkbox", { name: /two-channel local/i }),
    );
    await studio.screen.findByText("Local Ch 1");

    // Channel 1 presigns immediately (its server track now exists); channel
    // 2's presign hangs, holding the whole startup window open.
    let releaseSecondSlot: (() => void) | undefined;
    studio.harness.getPresignedUploadTarget.mockImplementation(
      async (
        _sessionId: string,
        _trackId: string,
        _part: number,
        _name: string,
        init?: { localTrackSlotId?: string },
      ) => {
        if (init?.localTrackSlotId === "host-local-ch-2") {
          await new Promise<void>((resolve) => {
            releaseSecondSlot = resolve;
          });
        }
        return {
          url: "https://s3.example/0.webm",
          key: "sessions/session-host/tracks/x/0.webm",
          recordingToken: `token-${init?.localTrackSlotId}`,
          trackId: `track-${init?.localTrackSlotId}`,
          segmentId: `segment-${init?.localTrackSlotId}`,
        };
      },
    );

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Start recording" }),
    );

    // Startup is pending: not yet "recording", but a server track exists.
    await waitFor(() => {
      expect(releaseSecondSlot).toBeDefined();
    });
    expect(
      studio.screen.queryByRole("button", { name: "Stop recording" }),
    ).toBeNull();
    await waitFor(() => {
      expect(lastGuardCall(studio.harness).when).toBe(true);
    });

    // Let startup finish and stop cleanly: everything confirms, guard down.
    releaseSecondSlot?.();
    await studio.screen.findByRole("button", { name: "Stop recording" });
    fireEvent.click(
      studio.screen.getByRole("button", { name: "Stop recording" }),
    );
    await studio.screen.findByRole("button", { name: "Start recording" });
    await waitFor(() => {
      expect(lastGuardCall(studio.harness).when).toBe(false);
    });
  });

  it("keeps the guard armed after a failed take even when the next take succeeds", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

    // Durable-store stand-in: take 1's failed backup must outlive take 2's
    // clean finish, exactly like IndexedDB does. Each take gets fresh
    // server-side ids (as in production) so the two takes' backups are
    // distinct records keyed the way recordingBackupId derives them.
    const store: Record<string, ReturnType<typeof backupManifest>> = {};
    let presignSeq = 0;
    studio.harness.getPresignedUploadTarget.mockImplementation(async () => {
      presignSeq += 1;
      return {
        url: "https://s3.example/0.webm",
        key: `sessions/session-host/tracks/take-${presignSeq}/0.webm`,
        recordingToken: `token-take-${presignSeq}`,
        trackId: `track-take-${presignSeq}`,
        segmentId: `segment-take-${presignSeq}`,
      };
    });
    studio.harness.recordingBackupStore.startBackup.mockImplementation(
      async (input: {
        sessionId: string;
        trackId: string;
        segmentId: string;
      }) => {
        const m = backupManifest({
          id: `${input.sessionId}:${input.segmentId}`,
          trackId: input.trackId,
          segmentId: input.segmentId,
          state: "recording",
          chunks: [],
        });
        store[m.id as string] = m;
        return m;
      },
    );
    studio.harness.recordingBackupStore.markBackupFailed.mockImplementation(
      async (id: string) => {
        const failed = backupManifest({
          id,
          state: "failed",
          chunks: [{ index: 0, byteSize: 5, uploadStatus: "failed" }],
        });
        store[id] = failed;
        return failed;
      },
    );
    studio.harness.recordingBackupStore.clearBackup.mockImplementation(
      async (id: string) => {
        delete store[id];
      },
    );
    studio.harness.recordingBackupStore.getBackup.mockImplementation(
      async (id: string) => store[id] ?? null,
    );
    studio.harness.listBackups.mockImplementation(async () =>
      Object.values(store).filter((m) => m.state === "failed"),
    );

    // Take 1: server-side completion fails, backup kept.
    studio.harness.completeUpload.mockRejectedValueOnce(
      new Error("complete failed"),
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

    // Take 2: completes cleanly — but take 1's audio is still unresolved.
    fireEvent.click(
      studio.screen.getByRole("button", { name: "Start recording" }),
    );
    await studio.screen.findByRole("button", { name: "Stop recording" });
    fireEvent.click(
      studio.screen.getByRole("button", { name: "Stop recording" }),
    );
    await studio.screen.findByRole("button", { name: "Start recording" });

    await waitFor(() => {
      expect(studio.harness.listBackups).toHaveBeenCalled();
    });
    const guard = lastGuardCall(studio.harness);
    expect(guard.when).toBe(true);
    expect(guard.message).toBe(UPLOADING_MESSAGE);
    expect(studio.screen.queryByText("All audio uploaded")).toBeNull();
    // The panel resurfaces take 1's backup so the armed guard has a way out.
    expect(
      await studio.screen.findByRole("button", { name: "Retry upload" }),
    ).toBeTruthy();
  });

  it("surfaces the sibling backup after retrying one of two failed channels", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

    fireEvent.click(
      studio.screen.getByRole("checkbox", { name: /two-channel local/i }),
    );
    await studio.screen.findByText("Local Ch 1");

    // Both channels record; both completions fail on stop, keeping two
    // recoverable backups behind one panel slot. Per-slot presign targets so
    // the two backups get distinct manifest ids.
    studio.harness.getPresignedUploadTarget.mockImplementation(
      async (
        _sessionId: string,
        _trackId: string,
        _part: number,
        _name: string,
        init?: { localTrackSlotId?: string },
      ) => ({
        url: "https://s3.example/0.webm",
        key: "sessions/session-host/tracks/x/0.webm",
        recordingToken: `token-${init?.localTrackSlotId ?? "primary"}`,
        trackId: `track-${init?.localTrackSlotId ?? "primary"}`,
        segmentId: `segment-${init?.localTrackSlotId ?? "primary"}`,
      }),
    );
    const manifests: Record<string, ReturnType<typeof backupManifest>> = {};
    studio.harness.recordingBackupStore.startBackup.mockImplementation(
      async (input: { sessionId: string; trackId: string; segmentId?: string }) => {
        const m = backupManifest({
          id: `${input.sessionId}:${input.segmentId}`,
          trackId: input.trackId,
          segmentId: input.segmentId,
          state: "recording",
          chunks: [],
        });
        manifests[m.id as string] = m;
        return m;
      },
    );
    studio.harness.recordingBackupStore.markBackupFailed.mockImplementation(
      async (id: string) => {
        const failed = backupManifest({
          ...(manifests[id] ?? {}),
          id,
          state: "failed",
          chunks: [{ index: 0, byteSize: 5, uploadStatus: "failed" }],
        });
        manifests[id] = failed;
        return failed;
      },
    );
    studio.harness.recordingBackupStore.getBackup.mockImplementation(
      async (id: string) => manifests[id] ?? null,
    );
    studio.harness.completeUpload.mockRejectedValue(
      new Error("complete failed"),
    );
    studio.harness.retryLocalRecordingBackupUpload.mockImplementation(
      async (m: { id: string }) => {
        delete manifests[m.id];
        return backupManifest({ id: m.id, state: "uploaded" });
      },
    );
    studio.harness.listBackups.mockImplementation(async () =>
      Object.values(manifests).filter((m) => m.state === "failed"),
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

    // First retry clears one backup; the sibling must take over the panel
    // instead of the panel vanishing while the guard stays armed.
    fireEvent.click(
      await studio.screen.findByRole("button", { name: "Retry upload" }),
    );
    await waitFor(() => {
      expect(
        studio.harness.retryLocalRecordingBackupUpload,
      ).toHaveBeenCalledTimes(1);
    });
    expect(
      await studio.screen.findByRole("button", { name: "Retry upload" }),
    ).toBeTruthy();
    expect(lastGuardCall(studio.harness).when).toBe(true);
    expect(studio.screen.queryByText("All audio uploaded")).toBeNull();

    // Second retry clears the last backup: panel gone, guard down, all-clear.
    fireEvent.click(
      studio.screen.getByRole("button", { name: "Retry upload" }),
    );
    await waitFor(() => {
      expect(
        studio.harness.retryLocalRecordingBackupUpload,
      ).toHaveBeenCalledTimes(2);
    });
    expect(await studio.screen.findByText("All audio uploaded")).toBeTruthy();
    await waitFor(() => {
      expect(lastGuardCall(studio.harness).when).toBe(false);
    });
    expect(
      studio.screen.queryByRole("button", { name: "Retry upload" }),
    ).toBeNull();
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
