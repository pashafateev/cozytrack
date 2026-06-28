import { describe, expect, it } from "vitest";
import {
  renderGuestStudioPage,
  renderHostStudioPage,
  studioPageTestHarness,
} from "./helpers/studio-page";

describe("StudioPage participant role labels", () => {
  it("does not label the local participant as host when a guest joins", async () => {
    const studio = renderGuestStudioPage({ name: "Guest Alice" });

    await studio.join();

    expect(studio.screen.getByText("Guest Alice")).toBeTruthy();
    expect(studio.screen.queryByText("host")).toBeNull();
  });
});

describe("StudioPage recording start", () => {
  it("starts host recordings without injecting a sync marker chirp", async () => {
    const studio = renderHostStudioPage({
      name: "Host Pasha",
      sessionId: "session-host",
    });

    await studio.join();
    await studio.startRecording();

    expect(
      studioPageTestHarness.createSyncMarkerRecordingStream,
    ).not.toHaveBeenCalled();

    const [, , , , trackInit] =
      studioPageTestHarness.getPresignedUploadTarget.mock.calls[0];
    expect(trackInit).toMatchObject({
      takeId: "take-1",
    });
    expect(trackInit).not.toHaveProperty("syncMarker");
  });
});
