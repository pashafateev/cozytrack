import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderGuestStudioPage, renderHostStudioPage } from "./helpers/studio-page";

// Two-channel local recording (issue #135): the host can split one desktop
// audio interface into two host-owned channels, each recorded as its own
// logical track alongside remote participants.

describe("StudioPage two-channel local mode", () => {
  it("is host-only — guests never see the toggle", async () => {
    const studio = renderGuestStudioPage({ name: "Guest Alice" });
    await studio.join();

    expect(
      studio.screen.queryByRole("checkbox", { name: /two-channel local/i }),
    ).toBeNull();
  });

  it("renders two named local channel rows when enabled", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

    fireEvent.click(
      studio.screen.getByRole("checkbox", { name: /two-channel local/i }),
    );

    await waitFor(() => {
      expect(studio.screen.getByText("Local Ch 1")).toBeTruthy();
      expect(studio.screen.getByText("Local Ch 2")).toBeTruthy();
    });
  });

  it("records both channels with distinct host slot ids", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

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
        trackId: init?.localTrackSlotId ?? "track-1",
        segmentId: init?.localTrackSlotId ?? "segment-1",
      }),
    );

    fireEvent.click(
      studio.screen.getByRole("checkbox", { name: /two-channel local/i }),
    );
    await studio.screen.findByText("Local Ch 1");

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Start recording" }),
    );

    await studio.screen.findByRole("button", { name: "Stop recording" });

    const slotIds = (
      studio.harness.getPresignedUploadTarget.mock.calls as unknown[][]
    )
      .map((call) => (call[4] as { localTrackSlotId?: string } | undefined)?.localTrackSlotId)
      .filter(Boolean);
    expect(slotIds).toContain("host-local-ch-1");
    expect(slotIds).toContain("host-local-ch-2");
    // One recorder per channel.
    expect(studio.harness.recorderStart).toHaveBeenCalledTimes(2);
  });

  it("completes both channel uploads on stop", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

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
        trackId: init?.localTrackSlotId ?? "track-1",
        segmentId: init?.localTrackSlotId ?? "segment-1",
      }),
    );

    fireEvent.click(
      studio.screen.getByRole("checkbox", { name: /two-channel local/i }),
    );
    await studio.screen.findByText("Local Ch 1");

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Start recording" }),
    );
    await studio.screen.findByRole("button", { name: "Stop recording" });

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Stop recording" }),
    );

    await waitFor(() => {
      const completedTracks = (
        studio.harness.completeUpload.mock.calls as unknown[][]
      ).map((call) => call[1]);
      expect(completedTracks).toContain("host-local-ch-1");
      expect(completedTracks).toContain("host-local-ch-2");
    });
  });

  it("still completes the healthy channel when the other channel's final upload fails", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

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
        trackId: init?.localTrackSlotId ?? "track-1",
        segmentId: init?.localTrackSlotId ?? "segment-1",
      }),
    );
    // Fail only Ch 1's final (partNumber 9999) upload URL.
    studio.harness.getPresignedUploadUrl.mockImplementation(
      async (...args: unknown[]) => {
        const trackId = args[1] as string;
        const part = args[2] as number;
        if (trackId === "host-local-ch-1" && part === 9999) {
          throw new Error("ch1 final upload failed");
        }
        return "https://s3.example/recording.webm";
      },
    );

    fireEvent.click(
      studio.screen.getByRole("checkbox", { name: /two-channel local/i }),
    );
    await studio.screen.findByText("Local Ch 1");

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Start recording" }),
    );
    await studio.screen.findByRole("button", { name: "Stop recording" });

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Stop recording" }),
    );

    await waitFor(() => {
      const completedTracks = (
        studio.harness.completeUpload.mock.calls as unknown[][]
      ).map((call) => call[1]);
      // Ch 2 must complete even though Ch 1's final upload threw...
      expect(completedTracks).toContain("host-local-ch-2");
      // ...and Ch 1 must NOT be completed (its recording never finalized).
      expect(completedTracks).not.toContain("host-local-ch-1");
    });
    // Ch 1's local backup is kept + marked failed for recovery.
    expect(
      studio.harness.recordingBackupStore.markBackupFailed,
    ).toHaveBeenCalledWith("session-host:host-local-ch-1", expect.anything());
  });

  it("disables the record button while two-channel capture is unavailable", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

    studio.harness.splitStereoStream.mockReturnValue({
      state: "unsupported",
      reason: "cannot prove 2 channels",
    });

    fireEvent.click(
      studio.screen.getByRole("checkbox", { name: /two-channel local/i }),
    );

    await waitFor(() => {
      const recButton = studio.screen.getByRole("button", {
        name: "Start recording",
      }) as HTMLButtonElement;
      expect(recButton.disabled).toBe(true);
    });

    // Clicking the disabled button must not start a take or broadcast to remotes.
    fireEvent.click(
      studio.screen.getByRole("button", { name: "Start recording" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(studio.harness.startRecordingTake).not.toHaveBeenCalled();
    expect(
      studio.harness.sendControlMessage.mock.calls.some(
        ([message]) => message.type === "recording_start",
      ),
    ).toBe(false);
  });

  it("finalizes an already-started channel when the other channel fails to start", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

    // Ch 1 presigns fine; Ch 2's presign rejects so it never starts.
    studio.harness.getPresignedUploadTarget.mockImplementation(
      async (
        _sessionId: string,
        _trackId: string,
        _part: number,
        _name: string,
        init?: { localTrackSlotId?: string },
      ) => {
        if (init?.localTrackSlotId === "host-local-ch-2") {
          throw new Error("ch2 presign failed");
        }
        return {
          url: "https://s3.example/0.webm",
          key: "sessions/session-host/tracks/x/0.webm",
          recordingToken: `token-${init?.localTrackSlotId ?? "primary"}`,
          trackId: init?.localTrackSlotId ?? "track-1",
          segmentId: init?.localTrackSlotId ?? "segment-1",
        };
      },
    );

    fireEvent.click(
      studio.screen.getByRole("checkbox", { name: /two-channel local/i }),
    );
    await studio.screen.findByText("Local Ch 1");

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Start recording" }),
    );

    // The started Ch 1 track is finalized (not left dangling in `recording`)...
    await waitFor(() => {
      const completedTracks = (
        studio.harness.completeUpload.mock.calls as unknown[][]
      ).map((call) => call[1]);
      expect(completedTracks).toContain("host-local-ch-1");
    });
    // ...and the failed start rolls the room back to idle.
    await waitFor(() => {
      expect(
        studio.screen.getByRole("button", { name: "Start recording" }),
      ).toBeTruthy();
    });
  });
});
