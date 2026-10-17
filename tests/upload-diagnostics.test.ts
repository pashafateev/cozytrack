import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUploadDiagnosticContext,
  createUploadDiagnostics,
  UPLOAD_DIAGNOSTICS_STORAGE_KEY,
} from "@/lib/upload-diagnostics";

const NOW = Date.UTC(2026, 9, 17);
const context = {
  attemptId: "attempt-1",
  sessionId: "session-1",
  trackId: "track-1",
  segmentId: "segment-1",
  kind: "final" as const,
  recordingToken: "private-recording-token",
};

function memoryStorage(initial = "") {
  let value = initial;
  return {
    getItem: (_key: string) => value || null,
    setItem: (_key: string, next: string) => { value = next; },
    contents: () => value,
  };
}

function harness(initial = "") {
  const storage = memoryStorage(initial);
  const requests: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status: 204 });
  });
  const client = createUploadDiagnostics({ storage, fetch: fetcher, now: () => NOW });
  return { storage, fetcher, requests, client };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("upload diagnostics browser journal", () => {
  it("retains failed and successful retry history after delivery and reload", async () => {
    const { client, storage, fetcher, requests } = harness();
    client.record(context, { stage: "put", outcome: "failed", errorCategory: "network" });
    client.record({ ...context, attemptId: "attempt-2", kind: "retry" }, {
      stage: "complete", outcome: "succeeded", trackStatus: "complete",
    });
    await client.flush();

    const restarted = createUploadDiagnostics({ storage, fetch: fetcher, now: () => NOW });
    expect(restarted.report("session-1").events).toMatchObject([
      { attemptId: "attempt-1", stage: "put", outcome: "failed" },
      { attemptId: "attempt-2", stage: "complete", outcome: "succeeded" },
    ]);
    await restarted.flush();
    expect(requests).toHaveLength(1);
  });

  it("excludes tokens, URLs, raw errors, and names from storage, requests, and reports", async () => {
    const { client, storage, requests } = harness();
    client.record(context, {
      stage: "put", outcome: "failed", errorCategory: "network",
      message: "private-error https://signed.example/?secret=abc", participantName: "Alice",
    } as Parameters<typeof client.record>[1]);
    await client.flush();

    const saved = storage.contents();
    const report = JSON.stringify(client.report("session-1"));
    const body = requests[0].init.body as string;
    for (const text of [saved, report, body]) {
      expect(text).not.toMatch(/private-recording-token|private-error|signed\.example|Alice/);
    }
    expect(requests[0].init.headers).toMatchObject({
      "X-Cozytrack-Recording-Token": "private-recording-token",
    });
    expect(requests[0].init.credentials).toBe("same-origin");
    expect(requests[0].url).toBe("/api/upload/diagnostics");
    expect(client.report("session-1").events[0]).not.toHaveProperty("delivered");
  });

  it("omits ordinary chunk events but retains chunk failures and all final/retry events", () => {
    const { client } = harness();
    client.record({ ...context, kind: "chunk" }, { stage: "put", outcome: "started" });
    client.record({ ...context, kind: "chunk" }, { stage: "put", outcome: "succeeded" });
    client.record({ ...context, kind: "chunk" }, { stage: "put", outcome: "failed" });
    client.record(context, { stage: "presign", outcome: "started" });
    client.record({ ...context, kind: "retry" }, { stage: "complete", outcome: "succeeded" });
    expect(client.report("session-1").events).toHaveLength(3);
  });

  it("keeps recent history bounded and expires events older than seven days", () => {
    const { client, storage, fetcher } = harness();
    for (let index = 0; index < 320; index++) {
      client.record({ ...context, attemptId: `attempt-${index}` }, {
        stage: "put", outcome: "failed",
      });
    }
    const events = client.report("session-1").events;
    expect(events).toHaveLength(300);
    expect(events[0].attemptId).toBe("attempt-20");
    expect(storage.contents().length).toBeLessThanOrEqual(192_000);
    const later = createUploadDiagnostics({
      storage, fetch: fetcher, now: () => NOW + 8 * 24 * 60 * 60 * 1000,
    });
    expect(later.report("session-1").events).toEqual([]);
  });

  it("revalidates persisted entries and ignores malformed storage", () => {
    const event = {
      version: 1, id: "event-safe", attemptId: "attempt-safe", sessionId: "session-1",
      trackId: "track-1", kind: "final", stage: "put", outcome: "failed", at: NOW,
      recordingToken: "private-recording-token", url: "https://private.example",
    };
    const { client } = harness(JSON.stringify({ version: 1, entries: [
      { event, delivered: false },
      { event: { ...event, id: "bad url!" }, delivered: false },
      { event: { ...event, id: "event-bad", stage: "secret-stage" }, delivered: false },
      null,
    ] }));
    expect(client.report("session-1").events).toEqual([{
      version: 1, id: "event-safe", attemptId: "attempt-safe", sessionId: "session-1",
      trackId: "track-1", kind: "final", stage: "put", outcome: "failed", at: NOW,
    }]);
    expect(harness("{not valid json").client.report("session-1").events).toEqual([]);
  });

  it("preserves sequential writes from another tab", () => {
    const { client, storage, fetcher } = harness();
    const otherTab = createUploadDiagnostics({ storage, fetch: fetcher, now: () => NOW });
    client.record(context, { stage: "put", outcome: "failed" });
    otherTab.record({ ...context, attemptId: "other-tab" }, { stage: "put", outcome: "failed" });
    client.record({ ...context, attemptId: "last" }, { stage: "complete", outcome: "succeeded" });
    expect(otherTab.report("session-1").events.map(event => event.attemptId)).toEqual([
      "attempt-1", "other-tab", "last",
    ]);
  });

  it("isolates the downloaded report to its session", () => {
    const { client } = harness();
    client.record(context, { stage: "put", outcome: "failed" });
    client.record({ ...context, sessionId: "session-2" }, { stage: "put", outcome: "failed" });
    expect(client.report("session-1").events).toHaveLength(1);
    expect(client.report("session-2").events[0].sessionId).toBe("session-2");
  });

  it("keeps a memory fallback when local storage throws", () => {
    const client = createUploadDiagnostics({
      storage: { getItem() { throw new Error("unavailable"); }, setItem() { throw new Error("full"); } },
      fetch: vi.fn(), now: () => NOW,
    });
    expect(() => client.record(context, { stage: "put", outcome: "failed" })).not.toThrow();
    expect(client.report("session-1").events).toHaveLength(1);
  });

  it("creates unique safe attempt IDs when browser randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", { randomUUID() { throw new Error("unavailable"); } });
    try {
      const first = createUploadDiagnosticContext(context);
      const second = createUploadDiagnosticContext(context);
      expect(first.attemptId).toMatch(/^[a-zA-Z0-9_-]{1,80}$/);
      expect(second.attemptId).not.toBe(first.attemptId);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("upload diagnostics delivery", () => {
  it("debounces delivery and caps batches at twenty events with one auth scope each", async () => {
    const { client, requests } = harness();
    for (let index = 0; index < 23; index++) {
      client.record(context, { stage: "put", outcome: "started" });
    }
    client.record({ ...context, trackId: "track-2", recordingToken: "second-token" }, {
      stage: "put", outcome: "failed",
    });
    expect(requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(requests.map(request => JSON.parse(request.init.body as string).events.length)).toEqual([20, 3, 1]);
    expect(requests[2].init.headers).toMatchObject({ "X-Cozytrack-Recording-Token": "second-token" });
  });

  it("does not block on rejected transport or retry in a loop", async () => {
    const { client, fetcher, storage } = harness();
    fetcher.mockRejectedValue(new Error("private-fetch-error"));
    expect(() => client.record(context, { stage: "put", outcome: "failed" })).not.toThrow();
    await expect(client.flush()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(storage.contents()).not.toContain("private-fetch-error");
    fetcher.mockResolvedValue(new Response(null, { status: 204 }));
    await client.flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(client.report("session-1").events).toHaveLength(1);
  });

  it("times out stalled delivery after five seconds and retains it for retry", async () => {
    const { client, fetcher } = harness();
    fetcher.mockImplementation(() => new Promise<Response>(() => {}));
    client.record(context, { stage: "put", outcome: "failed" });
    const flushing = client.flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(flushing).resolves.toBeUndefined();
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(client.report("session-1").events).toHaveLength(1);
  });

  it("retries rejected HTTP batches after reload without restoring recording tokens", async () => {
    const { client, fetcher, storage } = harness();
    fetcher.mockResolvedValue(new Response(null, { status: 503 }));
    client.record(context, { stage: "put", outcome: "failed" });
    await client.flush();
    const afterReload = vi.fn(async () => new Response(null, { status: 204 }));
    const restarted = createUploadDiagnostics({ storage, fetch: afterReload, now: () => NOW });
    await restarted.flush();
    expect(afterReload).toHaveBeenCalledWith("/api/upload/diagnostics", expect.objectContaining({
      credentials: "same-origin", headers: { "Content-Type": "application/json" },
    }));
  });

  it("does not starve later scopes when earlier scopes keep failing", async () => {
    const { client, requests, fetcher } = harness();
    fetcher.mockImplementation(async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      const trackId = JSON.parse(init?.body as string).events[0].trackId;
      return new Response(null, { status: trackId === "track-5" ? 204 : 403 });
    });
    for (let index = 1; index <= 5; index++) {
      client.record({ ...context, trackId: `track-${index}` }, { stage: "put", outcome: "failed" });
    }
    await client.flush();
    expect(requests).toHaveLength(4);
    await client.flush();
    expect(requests.some(request => JSON.parse(request.init.body as string).events[0].trackId === "track-5")).toBe(true);
  });

  it("exports a sanitized session report as a JSON download and retries on online", async () => {
    vi.resetModules();
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    vi.stubGlobal("localStorage", storage);
    storage.setItem("cozytrack-audio-backup-marker", "keep-audio");
    const fetcher = vi.fn().mockRejectedValue(new TypeError("offline"));
    vi.stubGlobal("fetch", fetcher);
    const blobs: Blob[] = [];
    const objectUrl = vi.spyOn(URL, "createObjectURL").mockImplementation(blob => {
      blobs.push(blob as Blob);
      return "blob:diagnostics";
    });
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const clicked: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    });
    // Keep the module's online listener contained to this simulated browser.
    const addListener = vi.spyOn(window, "addEventListener");
    try {
      const diagnostics = await import("@/lib/upload-diagnostics");
      diagnostics.recordUploadDiagnostic(context, { stage: "put", outcome: "failed" });
      diagnostics.recordUploadDiagnostic({ ...context, sessionId: "other-session" }, { stage: "put", outcome: "failed" });
      await diagnostics.flushUploadDiagnostics();
      await diagnostics.downloadUploadDiagnostics("session-1");
      expect(clicked).toEqual(["cozytrack-upload-diagnostics-session-1.json"]);
      expect(blobs[0].type).toBe("application/json");
      const report = JSON.parse(await blobs[0].text());
      expect(report.events).toHaveLength(1);
      expect(report.events[0].sessionId).toBe("session-1");
      expect(JSON.stringify(report)).not.toMatch(/recordingToken|delivered|private-recording-token/);
      expect(storage.getItem("cozytrack-audio-backup-marker")).toBe("keep-audio");
      expect(storage.getItem(UPLOAD_DIAGNOSTICS_STORAGE_KEY)).toBeTruthy();

      fetcher.mockClear().mockResolvedValue(new Response(null, { status: 204 }));
      window.dispatchEvent(new Event("online"));
      await diagnostics.flushUploadDiagnostics();
      expect(fetcher).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(revoke).toHaveBeenCalledWith("blob:diagnostics");
    } finally {
      for (const [type, listener] of addListener.mock.calls) {
        if (type === "online") window.removeEventListener(type, listener);
      }
      addListener.mockRestore();
      objectUrl.mockRestore();
      revoke.mockRestore();
      click.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
