import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderGuestStudioPage, renderHostStudioPage } from "./helpers/studio-page";

const quotaReason = "connection minutes limit exceeded. please contact the project owner.";

function connectionError(message = "could not establish signal connection: Encountered websocket error during connection establishment") {
  return Object.assign(new Error(message), { name: "ConnectionError" });
}

describe("Studio connection errors", () => {
  it("shows the minute-limit reason when the SDK supplies it", async () => {
    const studio = renderGuestStudioPage({ autoConnectRoom: false });
    await studio.join();
    const fetch = vi.mocked(globalThis.fetch).mockClear();

    act(() => studio.harness.roomOnError?.(connectionError(quotaReason)));

    const alert = await studio.screen.findByRole("alert");
    expect(alert.textContent).toMatch(/connection.minute limit reached/i);
    expect(alert.textContent).toMatch(/project owner/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("recovers the quota reason when the SDK replaces the 429 body with a generic error", async () => {
    const studio = renderGuestStudioPage({ autoConnectRoom: false });
    await studio.join();
    const fetch = vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(quotaReason, { status: 429 }),
    );

    act(() => studio.harness.roomOnError?.(connectionError()));

    await waitFor(() => {
      expect(studio.screen.getByRole("alert").textContent).toMatch(/connection.minute limit reached/i);
    });
    const [request, options] = fetch.mock.calls.at(-1)!;
    expect(new URL(String(request)).pathname).toBe("/rtc/validate");
    expect(new URL(String(request)).searchParams.get("access_token")).toBe("livekit-token");
    expect(options).toMatchObject({ credentials: "omit", cache: "no-store" });
    expect(studio.screen.getByText("Guest Alice")).toBeTruthy();
  });

  it.each([
    [429, "too many requests"],
    [503, quotaReason],
  ])("does not mislabel HTTP %s with body %s as a minute limit", async (status, body) => {
    const studio = renderGuestStudioPage({ autoConnectRoom: false });
    await studio.join();
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(body, { status }));

    act(() => studio.harness.roomOnError?.(connectionError()));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const alert = studio.screen.getByRole("alert");
    expect(alert.textContent).toMatch(/could not connect to live audio/i);
    expect(alert.textContent).not.toMatch(/minute limit/i);
    expect(alert.textContent).not.toContain(body);
  });

  it("keeps a safe general error when the diagnostic request fails", async () => {
    const studio = renderGuestStudioPage({ autoConnectRoom: false });
    await studio.join();
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("secret-token diagnostic failure"));

    act(() => studio.harness.roomOnError?.(connectionError()));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(studio.screen.getByRole("alert").textContent).toMatch(/could not connect to live audio/i);
    expect(studio.screen.getByRole("alert").textContent).not.toContain("secret-token");
  });

  it("does not probe LiveKit for a media-device error", async () => {
    const studio = renderGuestStudioPage();
    await studio.join();
    const fetch = vi.mocked(globalThis.fetch).mockClear();

    act(() => studio.harness.roomOnError?.(new Error("microphone unavailable")));

    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds a stalled diagnostic request and retains the general error", async () => {
    const studio = renderGuestStudioPage({ autoConnectRoom: false });
    await studio.join();
    let signal: AbortSignal | undefined;
    vi.mocked(globalThis.fetch).mockImplementationOnce((_url, options) => {
      signal = options?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    vi.useFakeTimers();
    try {
      act(() => studio.harness.roomOnError?.(connectionError()));
      expect(signal).toBeDefined();
      await vi.advanceTimersByTimeAsync(5000);
      expect(signal?.aborted).toBe(true);
      expect(studio.screen.getByRole("alert").textContent).toMatch(/could not connect to live audio/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending diagnostic when leaving the studio", async () => {
    const studio = renderGuestStudioPage({ autoConnectRoom: false });
    await studio.join();
    let signal: AbortSignal | undefined;
    vi.mocked(globalThis.fetch).mockImplementationOnce((_url, options) => {
      signal = options?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    act(() => studio.harness.roomOnError?.(connectionError()));
    cleanup();
    expect(signal?.aborted).toBe(true);
  });

  it("clears the error on connection and ignores a late diagnostic response", async () => {
    const studio = renderGuestStudioPage({ autoConnectRoom: false });
    await studio.join();
    let resolve!: (response: Response) => void;
    vi.mocked(globalThis.fetch).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));

    act(() => studio.harness.roomOnError?.(connectionError()));
    await studio.screen.findByRole("alert");
    studio.connectRoom();
    expect(studio.screen.queryByRole("alert")).toBeNull();

    resolve(new Response(quotaReason, { status: 429 }));
    await new Promise((done) => setTimeout(done, 0));
    expect(studio.screen.queryByRole("alert")).toBeNull();
  });

  it("preserves an active local recording while showing the connection error", async () => {
    const studio = renderHostStudioPage();
    await studio.join();
    fireEvent.click(studio.screen.getByRole("button", { name: "Start recording" }));
    await studio.screen.findByRole("button", { name: "Stop recording" });
    studio.harness.recorderStop.mockClear();

    act(() => studio.harness.roomOnError?.(connectionError(quotaReason)));
    await waitFor(() => {
      expect(studio.screen.getByRole("alert").textContent).toMatch(/connection.minute limit reached/i);
    });

    expect(studio.screen.getByRole("alert").textContent).toMatch(/connection.minute limit reached/i);
    expect(studio.screen.getByRole("button", { name: "Stop recording" })).toBeTruthy();
    expect(studio.harness.recorderStop).not.toHaveBeenCalled();
  });
});
