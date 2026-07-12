import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  renderHostStudioPage,
  setRemoteParticipants,
} from "./helpers/studio-page";

const BOB = { identity: "guest-bob", name: "Bob" };

describe("StudioPage presence notifications", () => {
  it("toasts a departure outside recording", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

    act(() => setRemoteParticipants([BOB]));
    act(() => setRemoteParticipants([]));

    expect(await studio.screen.findByText("Bob left the session")).toBeTruthy();
    expect(
      studio.screen.queryByText(/left during recording/),
    ).toBeNull();
  });

  it("toasts a rejoin and forgets the departure", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

    act(() => setRemoteParticipants([BOB]));
    act(() => setRemoteParticipants([]));
    await studio.screen.findByText("Bob left the session");

    act(() => setRemoteParticipants([BOB]));

    expect(await studio.screen.findByText("Bob rejoined")).toBeTruthy();
  });

  it("does not toast when a participant first joins", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

    act(() => setRemoteParticipants([BOB]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(studio.screen.queryByText("Bob joined")).toBeNull();
    expect(studio.screen.queryByText("Bob rejoined")).toBeNull();
    expect(studio.screen.queryByText("Bob left the session")).toBeNull();
  });

  it("shows a persistent banner when a participant leaves mid-recording", async () => {
    const studio = renderHostStudioPage();
    await studio.join();
    act(() => setRemoteParticipants([BOB]));

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Start recording" }),
    );
    await studio.screen.findByRole("button", { name: "Stop recording" });

    act(() => setRemoteParticipants([]));

    expect(
      await studio.screen.findByText(
        "Bob left during recording — their track may be incomplete.",
      ),
    ).toBeTruthy();
    // Banner, not toast: no plain departure toast for mid-recording exits.
    expect(studio.screen.queryByText("Bob left the session")).toBeNull();

    fireEvent.click(studio.screen.getByRole("button", { name: "dismiss" }));
    expect(
      studio.screen.queryByText(
        "Bob left during recording — their track may be incomplete.",
      ),
    ).toBeNull();
  });

  it("clears the banner and toasts when the participant rejoins mid-recording", async () => {
    const studio = renderHostStudioPage();
    await studio.join();
    act(() => setRemoteParticipants([BOB]));

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Start recording" }),
    );
    await studio.screen.findByRole("button", { name: "Stop recording" });

    act(() => setRemoteParticipants([]));
    await studio.screen.findByText(
      "Bob left during recording — their track may be incomplete.",
    );

    act(() => setRemoteParticipants([BOB]));

    expect(await studio.screen.findByText("Bob rejoined")).toBeTruthy();
    expect(
      studio.screen.queryByText(
        "Bob left during recording — their track may be incomplete.",
      ),
    ).toBeNull();
  });

  it("clears the banner when the take stops", async () => {
    const studio = renderHostStudioPage();
    await studio.join();
    act(() => setRemoteParticipants([BOB]));

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Start recording" }),
    );
    await studio.screen.findByRole("button", { name: "Stop recording" });

    act(() => setRemoteParticipants([]));
    await studio.screen.findByText(
      "Bob left during recording — their track may be incomplete.",
    );

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Stop recording" }),
    );
    await studio.screen.findByRole("button", { name: "Start recording" });

    expect(
      studio.screen.queryByText(
        "Bob left during recording — their track may be incomplete.",
      ),
    ).toBeNull();
  });

  it("feeds departed names into the finalize flow", async () => {
    const studio = renderHostStudioPage();
    await studio.join();
    act(() => setRemoteParticipants([BOB]));

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Start recording" }),
    );
    await studio.screen.findByRole("button", { name: "Stop recording" });

    act(() => setRemoteParticipants([]));

    fireEvent.click(
      studio.screen.getByRole("button", { name: "Stop recording" }),
    );
    const finish = await studio.screen.findByRole("button", {
      name: "Finish recording",
    });

    // Re-route fetch: finalize stays blocked on Bob's stuck track; every other
    // request keeps the harness auth-me behavior.
    const authMe = studio.harness.authMeResponse;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/finalize")) {
          return Response.json(
            {
              pending: [
                {
                  trackId: "track-bob",
                  participantName: "Bob",
                  status: "uploading",
                },
              ],
            },
            { status: 409 },
          );
        }
        return Response.json(authMe);
      }),
    );

    fireEvent.click(finish);

    expect(
      await studio.screen.findByText(
        "Bob left the session — recovering their uploaded audio…",
      ),
    ).toBeTruthy();
  });
});

describe("StudioPage departure toast names", () => {
  it("falls back to the identity when the participant has no display name", async () => {
    const studio = renderHostStudioPage();
    await studio.join();

    act(() => setRemoteParticipants([{ identity: "guest-7" }]));
    act(() => setRemoteParticipants([]));

    expect(
      await studio.screen.findByText("guest-7 left the session"),
    ).toBeTruthy();
  });
});
