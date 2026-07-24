import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  renderGuestStudioPage,
  renderHostStudioPage,
} from "./helpers/studio-page";

// The mute control only disables the published LiveKit preview track; the
// local recorder keeps rolling. What matters here is that the UI never lies:
// aria-pressed must track the actual outcome of setMicrophoneEnabled, not the
// optimistic click.
describe("StudioPage mute control", () => {
  it("mutes the published track and reflects the state once it succeeds", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

    const mute = studio.screen.getByRole("button", { name: "Mute microphone" });
    expect(mute.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(mute);

    await waitFor(() => {
      expect(studio.harness.setMicrophoneEnabled).toHaveBeenCalledWith(false);
      expect(
        studio.screen.getByRole("button", { name: "Unmute microphone" }),
      ).toBeTruthy();
    });

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Unmute microphone" }),
    );

    await waitFor(() => {
      expect(studio.harness.setMicrophoneEnabled).toHaveBeenCalledWith(true);
      expect(
        studio.screen.getByRole("button", { name: "Mute microphone" }),
      ).toBeTruthy();
    });
  });

  it("keeps the unmuted state and surfaces a notice when muting fails", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

    studio.harness.setMicrophoneEnabled.mockRejectedValueOnce(
      new Error("device busy"),
    );

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Mute microphone" }),
    );

    await waitFor(() => {
      expect(studio.harness.setMicrophoneEnabled).toHaveBeenCalledWith(false);
      expect(
        studio.screen.getByText("Couldn't mute your microphone"),
      ).toBeTruthy();
    });

    // The control still reads as unmuted — the room can still hear you, and
    // the UI must say so.
    const mute = studio.screen.getByRole("button", { name: "Mute microphone" });
    expect(mute.getAttribute("aria-pressed")).toBe("false");
    expect(
      studio.screen.queryByRole("button", { name: "Unmute microphone" }),
    ).toBeNull();
  });

  it("guest overflow mute row follows the muted state like the host control", async () => {
    const studio = renderGuestStudioPage();
    await studio.join();

    fireEvent.click(studio.screen.getByRole("button", { name: "More options" }));

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Mute microphone" }),
    );

    await waitFor(() => {
      expect(studio.harness.setMicrophoneEnabled).toHaveBeenCalledWith(false);
      expect(
        studio.screen.getByRole("button", { name: "Unmute microphone" }),
      ).toBeTruthy();
    });
    expect(
      studio.screen.queryByRole("button", { name: "Mute microphone" }),
    ).toBeNull();

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Unmute microphone" }),
    );

    await waitFor(() => {
      expect(studio.harness.setMicrophoneEnabled).toHaveBeenCalledWith(true);
      expect(
        studio.screen.getByRole("button", { name: "Mute microphone" }),
      ).toBeTruthy();
    });
  });
});
