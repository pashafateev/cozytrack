import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderGuestStudioPage, renderHostStudioPage } from "./helpers/studio-page";

// Stack 5 (reconnect-safe recording): a participant who (re)joins while a take
// is still active missed the live `recording_start` broadcast. On connecting,
// the studio page asks the server for the authoritative active take and, if one
// is still `recording`, resumes it by starting a fresh segment under the same
// logical track (presign re-links via the take id). Because RecordingTake.status
// is authoritative (a host stop flips it to "stopped"), a stopped take reports
// active:false and nothing resumes — no host-stop marker needed.

const activeTake = {
  active: true,
  sessionStartedAt: "2026-07-03T09:00:00.000Z",
  take: {
    id: "take-live",
    sessionId: "session-host",
    startedAt: "2026-07-03T09:00:00.000Z",
    stoppedAt: null,
    status: "recording",
  },
};

function takeIdOfPresign(harness: {
  getPresignedUploadTarget: { mock: { calls: unknown[][] } };
}): string | undefined {
  const call = harness.getPresignedUploadTarget.mock.calls.at(-1);
  const options = call?.[4] as { takeId?: string } | undefined;
  return options?.takeId;
}

describe("StudioPage reconnect catch-up", () => {
  it("resumes the active take for a returning host by starting a new segment", async () => {
    const studio = renderHostStudioPage();
    studio.harness.getRecordingTakeState.mockResolvedValue(activeTake);

    await studio.join();

    // No Start click: the catch-up effect should have resumed on its own.
    await waitFor(() => {
      expect(studio.harness.recorderStart).toHaveBeenCalled();
    });
    expect(takeIdOfPresign(studio.harness)).toBe("take-live");
    await studio.screen.findByRole("button", { name: "Stop recording" });
  });

  it("resumes the active take for a returning guest", async () => {
    const studio = renderGuestStudioPage();
    studio.harness.getRecordingTakeState.mockResolvedValue(activeTake);

    await studio.join();

    await waitFor(() => {
      expect(studio.harness.recorderStart).toHaveBeenCalled();
    });
    expect(takeIdOfPresign(studio.harness)).toBe("take-live");
  });

  it("does not resume when the server reports no active take", async () => {
    const studio = renderHostStudioPage();
    // Default harness state is inactive; assert we stay idle.

    await studio.join();
    // Give any pending catch-up effect a chance to run before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(studio.harness.recorderStart).not.toHaveBeenCalled();
    expect(
      studio.screen.getByRole("button", { name: "Start recording" }),
    ).toBeTruthy();
  });

  it("does not resume a take the host has already stopped", async () => {
    const studio = renderHostStudioPage();
    // A stopped take is authoritatively inactive: active:false even though a
    // take row exists.
    studio.harness.getRecordingTakeState.mockResolvedValue({
      active: false,
      sessionStartedAt: null,
      take: {
        id: "take-live",
        sessionId: "session-host",
        startedAt: "2026-07-03T09:00:00.000Z",
        stoppedAt: "2026-07-03T09:05:00.000Z",
        status: "stopped",
      },
    });

    await studio.join();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(studio.harness.recorderStart).not.toHaveBeenCalled();
    expect(
      studio.screen.getByRole("button", { name: "Start recording" }),
    ).toBeTruthy();
  });
});
