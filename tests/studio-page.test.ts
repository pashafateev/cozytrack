import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderGuestStudioPage, renderHostStudioPage } from "./helpers/studio-page";

describe("StudioPage participant role labels", () => {
  it("does not label the local participant as host when a guest joins", async () => {
    const studio = renderGuestStudioPage({ name: "Guest Alice" });

    await studio.join();

    expect(studio.screen.getByText("Guest Alice")).toBeTruthy();
    expect(studio.screen.queryByText("host")).toBeNull();
  });

  it("does not broadcast or stop locally when the authoritative stop fails", async () => {
    const studio = renderHostStudioPage();

    await studio.join();

    fireEvent.click(studio.screen.getByRole("button", { name: "Start recording" }));
    await studio.screen.findByRole("button", { name: "Stop recording" });

    studio.harness.sendControlMessage.mockClear();
    studio.harness.recorderStop.mockClear();
    studio.harness.stopRecordingTake.mockRejectedValueOnce(
      new Error("stop exhausted retries"),
    );

    fireEvent.click(studio.screen.getByRole("button", { name: "Stop recording" }));

    await waitFor(() => {
      expect(studio.harness.stopRecordingTake).toHaveBeenCalledWith(
        "session-host",
        { takeId: "take-1" },
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      studio.harness.sendControlMessage.mock.calls.some(
        ([message]) => message.type === "recording_stop",
      ),
    ).toBe(false);
    expect(studio.harness.recorderStop).not.toHaveBeenCalled();
    expect(
      studio.screen.getByRole("button", { name: "Stop recording" }),
    ).toBeTruthy();
  });

  it("broadcasts and stops locally when the durable stop has recovery pending", async () => {
    const studio = renderHostStudioPage();

    await studio.join();

    fireEvent.click(studio.screen.getByRole("button", { name: "Start recording" }));
    await studio.screen.findByRole("button", { name: "Stop recording" });

    studio.harness.sendControlMessage.mockClear();
    studio.harness.recorderStop.mockClear();
    studio.harness.stopRecordingTake.mockResolvedValueOnce({
      active: false,
      sessionStartedAt: null,
      recoveryPending: true,
      take: {
        id: "take-1",
        sessionId: "session-host",
        startedAt: "2026-06-27T12:00:00.000Z",
        stoppedAt: "2026-06-27T12:01:00.000Z",
        status: "stopped",
      },
    });

    fireEvent.click(studio.screen.getByRole("button", { name: "Stop recording" }));

    await waitFor(() => {
      expect(studio.harness.sendControlMessage).toHaveBeenCalledWith({
        type: "recording_stop",
      });
      expect(studio.harness.recorderStop).toHaveBeenCalled();
    });
  });
});
