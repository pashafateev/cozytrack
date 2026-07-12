import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecordingStateError } from "@/lib/recording-state";
import {
  renderGuestStudioPage,
  renderHostStudioPage,
  studioPageHarness,
} from "./helpers/studio-page";

// A finalized session must never dead-end the studio: the REC button is
// guaranteed to 409 server-side (issue #151), so the page has to surface the
// finalized state and hand the host a real path to a fresh session.
describe("StudioPage finalized session", () => {
  it("shows the finalized notice on prejoin and disables recording after join when the session is already finalized", async () => {
    studioPageHarness.sessionResponse = {
      id: "session-host",
      status: "ready",
    };

    const studio = renderHostStudioPage();

    // Prejoin: the mount-time status fetch surfaces the notice + host CTA
    // before the user pays the cost of joining a dead room.
    await studio.screen.findByText("Session finalized");
    expect(
      studio.screen.getByRole("button", { name: "Start a new session" }),
    ).toBeTruthy();

    await studio.join();

    const recButton = await studio.screen.findByRole("button", {
      name: "Session finalized",
    });
    expect((recButton as HTMLButtonElement).disabled).toBe(true);
    expect(
      studio.screen.getByRole("button", { name: "Start a new session" }),
    ).toBeTruthy();
  });

  it("flips into the finalized state when starting a take is rejected with a finalized 409", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

    expect(
      studio.screen.queryByRole("button", { name: "Start a new session" }),
    ).toBeNull();

    studio.harness.startRecordingTake.mockRejectedValueOnce(
      new RecordingStateError(
        "This session is finalized and can no longer be recorded into. Start a new session.",
        409,
      ),
    );

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Start recording" }),
    );

    await studio.screen.findByRole("button", { name: "Start a new session" });
    const recButton = studio.screen.getByRole("button", {
      name: "Session finalized",
    });
    expect((recButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not treat a generic start failure as a finalized session", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

    studio.harness.startRecordingTake.mockRejectedValueOnce(
      new Error("network blip"),
    );

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Start recording" }),
    );

    await studio.screen.findByText("Couldn't update recording state");
    expect(
      studio.screen.queryByRole("button", { name: "Start a new session" }),
    ).toBeNull();
    const recButton = studio.screen.getByRole("button", {
      name: "Start recording",
    });
    expect((recButton as HTMLButtonElement).disabled).toBe(false);
  });

  it("surfaces the start-a-new-session CTA after finishing a recording", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Start recording" }),
    );
    await studio.screen.findByRole("button", { name: "Stop recording" });
    fireEvent.click(
      studio.screen.getByRole("button", { name: "Stop recording" }),
    );

    fireEvent.click(
      await studio.screen.findByRole("button", { name: "Finish recording" }),
    );
    await studio.screen.findByText("Ready for ingest");

    // The ingest instructions stay visible; the finalized CTA appears
    // alongside them and the REC button locks.
    await studio.screen.findByRole("button", { name: "Start a new session" });
    const recButton = studio.screen.getByRole("button", {
      name: "Session finalized",
    });
    expect((recButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("creates a fresh session and navigates to it from the CTA", async () => {
    studioPageHarness.sessionResponse = {
      id: "session-host",
      status: "ready",
    };
    studioPageHarness.createSessionResponse = { id: "session-fresh" };

    const studio = renderHostStudioPage();
    const cta = await studio.screen.findByRole("button", {
      name: "Start a new session",
    });

    const assign = vi.fn();
    Object.defineProperty(window.location, "assign", {
      configurable: true,
      value: assign,
    });

    fireEvent.click(cta);

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith("/studio/session-fresh");
    });
    const fetchMock = window.fetch as ReturnType<typeof vi.fn>;
    const createCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        input === "/api/sessions" &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(createCall).toBeTruthy();
  });

  it("shows the finalized notice to guests without the create CTA", async () => {
    studioPageHarness.sessionResponse = {
      id: "session-guest",
      status: "ready",
    };

    const studio = renderGuestStudioPage();

    await studio.screen.findByText("Session finalized");
    expect(
      studio.screen.queryByRole("button", { name: "Start a new session" }),
    ).toBeNull();
  });
});
