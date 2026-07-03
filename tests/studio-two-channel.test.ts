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
});
