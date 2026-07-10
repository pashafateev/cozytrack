import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FinishRecordingButton } from "@/components/FinishRecordingButton";

const mocks = vi.hoisted(() => ({
  stopRecordingTake: vi.fn(),
}));

vi.mock("@/lib/recording-state", () => ({
  stopRecordingTake: mocks.stopRecordingTake,
}));

function response(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", vi.fn(() => true));
  mocks.stopRecordingTake.mockReset().mockResolvedValue({
    active: false,
    sessionStartedAt: null,
    take: null,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderButton() {
  render(
    React.createElement(FinishRecordingButton, {
      sessionId: "session-1",
      waitForUploads: async () => undefined,
    }),
  );
}

describe("FinishRecordingButton unfinished-take recovery", () => {
  it("stops blind polling and never ends the take automatically", async () => {
    fetchMock.mockResolvedValueOnce(
      response(
        {
          error: "An unfinished recording take is still active.",
          activeTake: {
            id: "take-orphan",
            startedAt: "2026-07-08T12:00:00.000Z",
          },
        },
        409,
      ),
    );
    renderButton();

    fireEvent.click(screen.getByRole("button", { name: "Finish recording" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(mocks.stopRecordingTake).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", {
        name: "End unfinished take and continue",
      }),
    ).toBeTruthy();
  });

  it("requires confirmation, targets the reported take, and retries finalization", async () => {
    fetchMock
      .mockResolvedValueOnce(
        response(
          {
            error: "An unfinished recording take is still active.",
            activeTake: {
              id: "take-orphan",
              startedAt: "2026-07-08T12:00:00.000Z",
            },
          },
          409,
        ),
      )
      .mockResolvedValueOnce(response({ status: "ready" }, 200));
    const confirmMock = vi.mocked(confirm);
    confirmMock.mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderButton();

    fireEvent.click(screen.getByRole("button", { name: "Finish recording" }));
    const recover = await screen.findByRole("button", {
      name: "End unfinished take and continue",
    });

    fireEvent.click(recover);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(mocks.stopRecordingTake).not.toHaveBeenCalled();

    fireEvent.click(recover);
    await waitFor(() => {
      expect(mocks.stopRecordingTake).toHaveBeenCalledWith("session-1", {
        takeId: "take-orphan",
      });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Ready for ingest")).toBeTruthy();
  });
});
