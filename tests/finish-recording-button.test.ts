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
let writeClipboard: ReturnType<typeof vi.fn<(data: string) => Promise<void>>>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", vi.fn(() => true));
  writeClipboard = vi.fn<(data: string) => Promise<void>>().mockResolvedValue(undefined);
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation(writeClipboard);
  mocks.stopRecordingTake.mockReset().mockResolvedValue({
    active: false,
    sessionStartedAt: null,
    take: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderButton(props: { departedParticipantNames?: string[] } = {}) {
  render(
    React.createElement(FinishRecordingButton, {
      sessionId: "session-1",
      waitForUploads: async () => undefined,
      ...props,
    }),
  );
}

describe("FinishRecordingButton ingest command", () => {
  it("shows and copies the full pod command after finalization succeeds", async () => {
    fetchMock.mockResolvedValueOnce(response({ id: "session-1", status: "ready" }, 200));
    renderButton();
    expect(screen.queryByText("pod ct-ingest session-1")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Finish recording" }));

    expect(await screen.findByText("pod ct-ingest session-1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(writeClipboard).toHaveBeenCalledWith("pod ct-ingest session-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/finalize", {
      method: "POST",
      signal: expect.any(AbortSignal),
    });
  });

  it("leaves the command available when copying after finalization is denied", async () => {
    fetchMock.mockResolvedValueOnce(response({ id: "session-1", status: "ready" }, 200));
    writeClipboard.mockRejectedValueOnce(new Error("Clipboard permission denied"));
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: "Finish recording" }));
    await screen.findByText("pod ct-ingest session-1");

    fireEvent.click(screen.getByRole("button", { name: /copy/i }));

    expect((await screen.findByRole("status")).textContent).toMatch(/select and copy the command/i);
    expect(writeClipboard).toHaveBeenCalledWith("pod ct-ingest session-1");
    expect(screen.getByText("pod ct-ingest session-1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^copied$/i })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

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

describe("FinishRecordingButton departed participants", () => {
  function pendingResponse(...participantNames: string[]): Response {
    return response(
      {
        pending: participantNames.map((participantName, index) => ({
          trackId: `track-${index}`,
          participantName,
          status: "uploading",
        })),
      },
      409,
    );
  }

  it("names the departed participant while their track blocks finalize", async () => {
    fetchMock.mockResolvedValue(pendingResponse("Bob"));
    renderButton({ departedParticipantNames: ["Bob"] });

    fireEvent.click(screen.getByRole("button", { name: "Finish recording" }));

    expect(
      await screen.findByText(
        "Bob left the session — recovering their uploaded audio…",
      ),
    ).toBeTruthy();
  });

  it("finds a departed participant anywhere in the pending list", async () => {
    fetchMock.mockResolvedValue(pendingResponse("Alice", "Bob"));
    renderButton({ departedParticipantNames: ["Bob"] });

    fireEvent.click(screen.getByRole("button", { name: "Finish recording" }));

    expect(
      await screen.findByText(
        "Bob left the session — recovering their uploaded audio…",
      ),
    ).toBeTruthy();
  });

  it("names the departed participant on timeout even when listed after present ones", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(pendingResponse("Alice", "Bob"));
      renderButton({ departedParticipantNames: ["Bob"] });

      fireEvent.click(screen.getByRole("button", { name: "Finish recording" }));

      await vi.advanceTimersByTimeAsync(31_000);

      expect(
        screen.getByText(
          "Bob left before their track finished uploading — retry to recover what they already uploaded.",
        ),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the plain uploading label for participants still present", async () => {
    fetchMock.mockResolvedValue(pendingResponse("Alice"));
    renderButton({ departedParticipantNames: ["Bob"] });

    fireEvent.click(screen.getByRole("button", { name: "Finish recording" }));

    expect(
      await screen.findByText("Still uploading track: Alice…"),
    ).toBeTruthy();
  });

  it("explains a departed participant's stuck track when polling times out", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(pendingResponse("Bob"));
      renderButton({ departedParticipantNames: ["Bob"] });

      fireEvent.click(screen.getByRole("button", { name: "Finish recording" }));

      await vi.advanceTimersByTimeAsync(31_000);

      expect(
        screen.getByText(
          "Bob left before their track finished uploading — retry to recover what they already uploaded.",
        ),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the generic timeout message when the stuck participant is still present", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(pendingResponse("Alice"));
      renderButton({ departedParticipantNames: ["Bob"] });

      fireEvent.click(screen.getByRole("button", { name: "Finish recording" }));

      await vi.advanceTimersByTimeAsync(31_000);

      expect(
        screen.getByText(
          "Some tracks haven't uploaded yet — check your network and retry.",
        ),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
