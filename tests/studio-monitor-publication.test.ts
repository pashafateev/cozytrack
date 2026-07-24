import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  mediaStream,
  renderGuestStudioPage,
  renderHostStudioPage,
} from "./helpers/studio-page";

describe("StudioPage realtime monitor publication", () => {
  it("disables LiveKit automatic microphone capture", async () => {
    const studio = renderHostStudioPage();

    await studio.join();

    expect(studio.harness.liveKitAudioProp).toBe(false);
  });

  it("publishes the primary mono stream at unity-gain routing when additional channel is off", async () => {
    const studio = renderHostStudioPage();
    await waitFor(() => {
      expect(studio.harness.getUserMedia).toHaveBeenCalledTimes(1);
    });
    const primary = mediaStream();
    const bus = mediaStream();
    studio.harness.getUserMedia.mockResolvedValueOnce(primary);
    studio.harness.createMonitorBus.mockReturnValueOnce({
      stream: bus,
      dispose: studio.harness.monitorBusDispose,
    });

    await studio.join();

    await waitFor(() => {
      expect(studio.harness.createMonitorBus).toHaveBeenCalledWith(primary);
      expect(studio.harness.publishAudio).toHaveBeenCalledWith(bus, {
        audioBitrate: 128_000,
        dtx: false,
      });
    });
  });

  it("publishes both split mono streams when the host enables the additional channel", async () => {
    const channel1 = mediaStream();
    const channel2 = mediaStream();
    const bus = mediaStream();
    const studio = renderHostStudioPage();
    studio.harness.splitStereoStream.mockReturnValue({
      state: "ok",
      channels: [channel1, channel2],
      dispose: studio.harness.splitterDispose,
    });

    await studio.join();
    studio.harness.createMonitorBus.mockClear();
    studio.harness.publishAudio.mockClear();
    studio.harness.createMonitorBus.mockReturnValueOnce({
      stream: bus,
      dispose: studio.harness.monitorBusDispose,
    });

    fireEvent.click(
      studio.screen.getByRole("checkbox", { name: /additional channel/i }),
    );

    await waitFor(() => {
      expect(studio.harness.createMonitorBus).toHaveBeenCalledWith(
        channel1,
        channel2,
      );
      expect(studio.harness.publishAudio).toHaveBeenCalledWith(bus, {
        audioBitrate: 128_000,
        dtx: false,
      });
    });
  });

  it("never falls back to raw publication when monitor-bus creation fails", async () => {
    const studio = renderHostStudioPage();
    studio.harness.createMonitorBus.mockImplementationOnce(() => {
      throw new Error("mono graph failed");
    });

    await studio.join();

    await waitFor(() => {
      expect(studio.harness.unpublishAudio).toHaveBeenCalled();
    });
    expect(studio.harness.publishAudio).not.toHaveBeenCalled();
  });

  it("keeps invited guests on their processed mono microphone stream", async () => {
    const studio = renderGuestStudioPage();

    await studio.join();

    await waitFor(() => {
      expect(studio.harness.createMonitorBus).toHaveBeenCalledTimes(1);
      expect(studio.harness.publishAudio).toHaveBeenCalledTimes(1);
    });
  });
});
